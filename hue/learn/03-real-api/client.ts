/**
 * 第三层：把前两课和上面两层接成一个真正的 StreamingModel。
 *
 *   ModelRequest ─toAnthropicBody─▶ JSON ─fetchWithRetry─▶ Response
 *        Response.body ─bodyBytes─▶ 字节 ─parseSSE─▶ SSE ─toChunks─▶ Chunk   （后三步是第 2 课）
 *
 * 成功路径上这里几乎没有新逻辑，新东西都在"失败路径"：HTTP 出错、网络断、被取消、连接要释放。
 */
import type { Chunk, ModelRequest, StreamingModel } from '../02-streaming/types.js'
import { toChunks } from '../02-streaming/anthropic.js'
import { parseSSE } from '../02-streaming/sse.js'
import { ApiError, fetchWithRetry, type RetryOptions } from './http.js'
import { toAnthropicBody, type RequestOptions } from './request.js'

export interface AnthropicModelOptions extends RequestOptions {
  apiKey: string
  baseURL?: string
  /** 默认 2，与官方 SDK 一致。0 表示不重试。 */
  maxRetries?: number
  /** 官方文档当前推荐 2026-10-21。作为选项是因为中转服务可能只认旧版本。 */
  anthropicVersion?: string
  // 可注入，便于离线测试。
  fetch?: typeof fetch
  sleep?: RetryOptions['sleep']
  random?: RetryOptions['random']
}

export function anthropicModel(o: AnthropicModelOptions): StreamingModel {
  const doFetch = o.fetch ?? fetch
  // 中转的地址常写成 https://host/v1，官方 SDK 的习惯是不带 /v1；两种写法都接受，避免拼出 /v1/v1/messages。
  const url = `${(o.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`
  const fail = (message: string, code: 'context_overflow' | 'model_error', retryable: boolean): Chunk => ({ type: 'error', message, code, retryable })

  return {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<Chunk> {
      let body: string
      try {
        body = JSON.stringify(toAnthropicBody(request, o))
      } catch (e) {
        yield fail(`invalid request: ${e instanceof Error ? e.message : String(e)}`, 'model_error', false)
        return
      }

      let res: Response
      try {
        res = await fetchWithRetry(doFetch, url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-api-key': o.apiKey,
            'anthropic-version': o.anthropicVersion ?? '2026-10-21',
          },
          body,
          signal,
        }, { maxRetries: o.maxRetries ?? 2, sleep: o.sleep, random: o.random })
      } catch (e) {
        // API 层面的失败变成 error 块（loop 会读 message）。取消和其他意外异常原样抛出。
        if (e instanceof ApiError) { yield fail(e.message, e.info.code, e.info.retryable); return }
        throw e
      }

      if (!res.body) { yield fail('response has no body', 'model_error', true); return }
      yield* toChunks(parseSSE(bodyBytes(res.body)))
    },
  }
}

/**
 * ReadableStream → 异步迭代的字节。
 * finally 里的 cancel 很重要：消费者提前停止（看到 finish 就 break、被取消）时，
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
