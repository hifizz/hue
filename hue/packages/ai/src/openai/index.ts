/**
 * OpenAI（Responses API）的 ModelPort。失败路径（重试、取消、连接释放）与 anthropic.ts 同构：
 * 流在产出用户可见 chunk 之前断开 → 静默重发；之后断开 → 可重试的 error 块。
 */
import type { ModelChunk, ModelPort } from '@hue/core'
import { ApiError, backoffMs, fetchWithRetry, sleep, type RetryOptions } from '../http.js'
import { parseSSE } from '../sse.js'
import { bodyBytes, type TraceEvent } from '../anthropic.js'
import { openaiInfo } from '../info.js'
import { toChunks, errorChunk } from './stream.js'
import { toOpenAIBody } from './request.js'

export interface OpenAIOptions {
  /** 默认读 OPENAI_API_KEY，再退 AI_GATEWAY_API_KEY（中转站的命名习惯）。 */
  apiKey?: string
  /** 默认读 OPENAI_BASE_URL / AI_GATEWAY_BASE_URL，再默认官方地址。带不带 /v1 都接受。 */
  baseURL?: string
  maxRetries?: number
  /** 'none' 关思考；其余值透传 reasoning.effort。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none'
  trace?: (e: TraceEvent) => void
  // 可注入，便于离线测试。
  fetch?: typeof fetch
  sleep?: RetryOptions['sleep']
  random?: RetryOptions['random']
}

export function openaiModel(name: string, o: OpenAIOptions = {}): ModelPort {
  const apiKey = o.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.AI_GATEWAY_API_KEY
  if (!apiKey) throw new Error('openai: missing apiKey (pass { apiKey } or set OPENAI_API_KEY / AI_GATEWAY_API_KEY)')
  const doFetch = o.fetch ?? fetch
  const base = (o.baseURL ?? process.env.OPENAI_BASE_URL ?? process.env.AI_GATEWAY_BASE_URL ?? 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '')
  const url = `${base}/v1/responses`
  const info = openaiInfo(name)

  return {
    specVersion: 'hue.model.v1',
    id: `openai:${name}`,
    info,
    async *stream(request, signal) {
      let body: string
      try {
        body = JSON.stringify(toOpenAIBody(request, { model: name, maxOutputTokens: Math.min(16_000, info.maxOutputTokens ?? 16_000), ...(o.effort && { effort: o.effort }) }))
      } catch (e) {
        yield errorChunk('model_error', `invalid request: ${e instanceof Error ? e.message : String(e)}`, false)
        return
      }

      const trace = (e: TraceEvent) => { try { o.trace?.(e) } catch { /* ignore */ } }
      trace({ type: 'request', url, body })

      const maxRetries = o.maxRetries ?? 2
      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await fetchWithRetry(doFetch, url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${apiKey}` },
            body,
            signal,
          }, { maxRetries, sleep: o.sleep, random: o.random })
        } catch (e) {
          if (e instanceof ApiError) { yield errorChunk(e.info.code, e.message, e.info.retryable); return }
          throw e
        }
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => { headers[k] = v })
        trace({ type: 'response', status: res.status, headers })
        if (!res.body) { yield errorChunk('model_error', 'response has no body', true); return }

        let userVisible = 0, failure: ModelChunk | undefined
        const t0 = Date.now()
        try {
          for await (const c of toChunks(parseSSE(bodyBytes(res.body)))) {
            if (c.type === 'error' && c.error.retryable && /^stream ended before response\.completed/.test(c.error.message)) { failure = c; break }
            if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'tool-input-delta') userVisible++
            yield c
          }
        } catch (e) {
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

const abortError = () => new DOMException('Aborted', 'AbortError')
