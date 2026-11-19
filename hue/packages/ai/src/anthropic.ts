/**
 * ModelRequest ─toAnthropicBody─▶ JSON ─fetchWithRetry─▶ Response
 *   Response.body ─bodyBytes─▶ 字节 ─parseSSE─▶ SSE ─toChunks─▶ ModelChunk
 *
 * 成功路径上几乎没有新逻辑，复杂度都在失败路径：HTTP 出错、网络断、被取消、连接要释放。
 */
import type { ModelChunk, ModelPort, ModelRequest } from '@hue/core'
import { anthropicInfo } from './info.js'
import { ApiError, backoffMs, fetchWithRetry, sleep, type RetryOptions } from './http.js'
import { toAnthropicBody, type RequestOptions } from './request.js'
import { parseSSE } from './sse.js'
import { errorChunk, toChunks } from './stream.js'

export interface AnthropicOptions extends Partial<Pick<RequestOptions, 'thinking' | 'effort' | 'cache'>> {
  /** 默认读 ANTHROPIC_API_KEY。 */
  apiKey?: string
  /** 默认读 ANTHROPIC_BASE_URL，再默认官方地址。中转常写成 https://host/v1，带不带 /v1 都接受。 */
  baseURL?: string
  /** 默认 2，与官方 SDK 一致。0 表示不重试。 */
  maxRetries?: number
  /** 中转服务可能只认旧版本，所以做成选项。 */
  anthropicVersion?: string
  /**
   * 调试用，默认关闭：看到实际发出的请求体和响应头。事件日志里没有这些，
   * 而"provider 到底收到了什么"（比如中转站是否改了系统提示）只有这里知道。
   * 不包含 API key（它只在请求头里，这里不给）。
   */
  trace?: (e: TraceEvent) => void
  // 可注入，便于离线测试。
  fetch?: typeof fetch
  sleep?: RetryOptions['sleep']
  random?: RetryOptions['random']
}

export type TraceEvent =
  | { type: 'request'; url: string; body: string }
  | { type: 'response'; status: number; headers: Record<string, string> }
  /** 流在产出任何内容之前断了，静默重发（第几次、为什么）。 */
  | { type: 'retry'; attempt: number; reason: string }
  /** 流中途失败（不论后来有没有重发）：失败前已经产出几个用户可见的 chunk、响应头到失败过了多久。userVisible > 0 时不会重发。 */
  | { type: 'stream-error'; chunks: number; ms: number; message: string }

const abortError = () => new DOMException('Aborted', 'AbortError')

export function anthropicModel(name: string, o: AnthropicOptions = {}): ModelPort {
  const apiKey = o.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('anthropic: missing apiKey (pass { apiKey } or set ANTHROPIC_API_KEY)')
  const doFetch = o.fetch ?? fetch
  const base = (o.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '')
  const url = `${base}/v1/messages`
  const info = anthropicInfo(name)

  return {
    specVersion: 'hue.model.v1',
    id: `anthropic:${name}`,
    info,
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk> {
      let body: string
      try {
        body = JSON.stringify(toAnthropicBody(request, { model: name, maxTokens: Math.min(16_000, info.maxOutputTokens ?? 16_000), cache: true, ...pick(o) }))
      } catch (e) {
        yield errorChunk('model_error', `invalid request: ${e instanceof Error ? e.message : String(e)}`, false)
        return
      }

      // trace 是调试钩子：它抛错不能影响请求。
      const trace = (e: TraceEvent) => { try { o.trace?.(e) } catch { /* ignore */ } }
      trace({ type: 'request', url, body })

      // 流在产出任何**用户可见**的 chunk 之前就断了可以静默重发：消费者只看到了协议骨架（reasoning-end、tool-call 的头部等），
      // 重发不会让用户看到重复的文本。一旦交出过 text-delta / reasoning-delta / tool-input-delta（UI 已经显示了内容）就不能重发。
      // M1 运行 E：中转站在 313 ms、只交出 2 个协议块后就掐断，按旧规则（任何 chunk 都不重发）整个 turn 丢掉——这个形态必须重发。
      // 次数和退避与 HTTP 层共用 maxRetries / sleep / random。
      const maxRetries = o.maxRetries ?? 2
      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await fetchWithRetry(doFetch, url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': apiKey, 'anthropic-version': o.anthropicVersion ?? '2026-10-21' },
            body,
            signal,
          }, { maxRetries, sleep: o.sleep, random: o.random })
        } catch (e) {
          if (e instanceof ApiError) { yield errorChunk(e.info.code, e.message, e.info.retryable); return }
          throw e // 取消和意外异常原样抛
        }
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => { headers[k] = v })
        trace({ type: 'response', status: res.status, headers })
        if (!res.body) { yield errorChunk('model_error', 'response has no body', true); return }

        // userVisible：已经交给消费者的、用户能看到的 chunk 数（text / reasoning / tool-input 的 delta）。
        // 其他块（reasoning-end、tool-call 的头部、finish、ping）只是协议骨架，重发不会让用户看到重复内容。
        let userVisible = 0, failure: ModelChunk | undefined
        const t0 = Date.now()
        try {
          for await (const c of toChunks(parseSSE(bodyBytes(res.body)))) {
            // 流没读完就结束：toChunks 给出的 retryable error 块，和读流抛错一样当作失败，交给下面统一决定重发还是上报。
            if (c.type === 'error' && c.error.retryable && /^stream ended before message_stop/.test(c.error.message)) { failure = c; break }
            if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'tool-input-delta') userVisible++
            yield c
          }
        } catch (e) {
          // 取消 → AbortError（合同要求）；其他读流失败（连接被重置等）→ 可重试的 error 块，而不是让异常冒出去。
          if (signal.aborted) throw abortError()
          failure = errorChunk('model_error', `stream read failed: ${e instanceof Error ? e.message : String(e)}`, true)
        }
        if (!failure) return
        const why = failure.type === 'error' ? failure.error.message : ''
        trace({ type: 'stream-error', chunks: userVisible, ms: Date.now() - t0, message: why })
        if (userVisible > 0 || attempt >= maxRetries) { yield failure; return }
        trace({ type: 'retry', attempt: attempt + 1, reason: why })
        await (o.sleep ?? sleep)(backoffMs(attempt, o.random), signal)
      }
    },
  }
}

const pick = (o: AnthropicOptions) => ({ ...(o.thinking && { thinking: o.thinking }), ...(o.effort && { effort: o.effort }), ...(o.cache !== undefined && { cache: o.cache }) })

/** ReadableStream → 异步迭代的字节。Anthropic / OpenAI 两个 ModelPort 共用。 */
async function* bodyBytes(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    await reader.cancel().catch(() => {}) // 流已出错或关闭时 cancel 会 reject，无所谓
  }
}

export { bodyBytes }
