/**
 * ModelRequest ─toAnthropicBody─▶ JSON ─fetchWithRetry─▶ Response
 *   Response.body ─bodyBytes─▶ 字节 ─parseSSE─▶ SSE ─toChunks─▶ ModelChunk
 *
 * 成功路径上几乎没有新逻辑，复杂度都在失败路径：HTTP 出错、网络断、被取消、连接要释放。
 */
import type { ModelPort, ModelChunk, ModelRequest } from '@hue/core'
import { anthropicInfo } from './info.js'
import { ApiError, fetchWithRetry, type RetryOptions } from './http.js'
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
  // 可注入，便于离线测试。
  fetch?: typeof fetch
  sleep?: RetryOptions['sleep']
  random?: RetryOptions['random']
}

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

      let res: Response
      try {
        res = await fetchWithRetry(doFetch, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': apiKey, 'anthropic-version': o.anthropicVersion ?? '2026-10-21' },
          body,
          signal,
        }, { maxRetries: o.maxRetries ?? 2, sleep: o.sleep, random: o.random })
      } catch (e) {
        if (e instanceof ApiError) { yield errorChunk(e.info.code, e.message, e.info.retryable); return }
        throw e // 取消和意外异常原样抛
      }
      if (!res.body) { yield errorChunk('model_error', 'response has no body', true); return }

      try {
        yield* toChunks(parseSSE(bodyBytes(res.body)))
      } catch (e) {
        // 取消 → AbortError（合同要求）；其他读流失败（连接被重置等）→ 可重试的 error 块，而不是让异常冒出去。
        if (signal.aborted) throw abortError()
        yield errorChunk('model_error', `stream read failed: ${e instanceof Error ? e.message : String(e)}`, true)
      }
    },
  }
}

const pick = (o: AnthropicOptions) => ({ ...(o.thinking && { thinking: o.thinking }), ...(o.effort && { effort: o.effort }), ...(o.cache !== undefined && { cache: o.cache }) })

/**
 * ReadableStream → 异步迭代的字节。
 * finally 里的 cancel 很重要：消费者提前停止（取消、看到错误就 return）时，
 * 不 cancel 的话底层 HTTP 连接会一直挂着，直到服务端把整个回复发完。
 */
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
