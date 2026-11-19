/**
 * OpenAI Responses 的 SSE 事件 → core 的 ModelChunk。
 *
 * 输出是 items 列表：reasoning / message / function_call 各占一个 item，
 * message 内部再有 content parts（output_text）。事件按 item_id 归属，不按 index。
 * function_call 的参数是增量 JSON 文本，攒到 output_item.done 才完整，和 Anthropic 一样。
 *
 * 无状态模式（store:false）下推理 item 带 encrypted_content：必须存进 reasoning-end 的
 * providerMetadata，下一轮原样发回，否则推理模型多轮工具调用会被拒绝或降智。
 */
import type { HueError, ModelChunk, ProviderMetadata, Usage } from '@hue/core'
import type { SSEMessage } from '../sse.js'
import { parseToolInput } from '../tooljson.js'

type OpenItem =
  | { kind: 'text' }
  | { kind: 'reasoning' }
  | { kind: 'tool'; callId: string; name: string; json: string }
  | { kind: 'ignored' }

const RETRYABLE_ERR = new Set(['server_error', 'rate_limit_exceeded', 'timeout', 'temporarily_unavailable'])

export const SOURCE = 'ai:openai'
export const errorChunk = (code: HueError['code'], message: string, retryable: boolean): ModelChunk =>
  ({ type: 'error', error: { code, message, retryable, source: SOURCE } })

const evType = (sse: SSEMessage): string => sse.event ?? sse.data.slice(0, 60)

export async function* toChunks(events: AsyncIterable<SSEMessage>): AsyncGenerator<ModelChunk> {
  const items = new Map<string, OpenItem>()
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let incomplete: string | undefined
  let sawCompleted = false, sawToolCall = false

  for await (const sse of events) {
    if (sse.data === '[DONE]') continue // OpenAI 流末尾的哨兵，不是 JSON
    let ev: any
    try { ev = JSON.parse(sse.data) } catch { yield errorChunk('model_error', `bad JSON in event "${evType(sse)}"`, false); return }

    switch (ev.type) {
      case 'response.output_item.added': {
        const it = ev.item ?? {}
        if (it.type === 'message') items.set(it.id, { kind: 'text' })
        else if (it.type === 'reasoning') items.set(it.id, { kind: 'reasoning' })
        else if (it.type === 'function_call') items.set(it.id, { kind: 'tool', callId: it.call_id, name: it.name, json: it.arguments ?? '' })
        else items.set(it.id, { kind: 'ignored' }) // web_search_call 等：跳过
        break
      }

      case 'response.output_text.delta': {
        const item = items.get(ev.item_id)
        if (item?.kind === 'text') yield { type: 'text-delta', text: ev.delta }
        break
      }

      case 'response.reasoning_summary_text.delta': {
        const item = items.get(ev.item_id)
        if (item?.kind === 'reasoning') yield { type: 'reasoning-delta', text: ev.delta }
        break
      }

      case 'response.function_call_arguments.delta': {
        const item = items.get(ev.item_id)
        if (item?.kind === 'tool') {
          item.json += ev.delta
          yield { type: 'tool-input-delta', callId: item.callId, name: item.name, delta: ev.delta }
        }
        break
      }

      case 'response.output_item.done': {
        const it = ev.item ?? {}
        const item = items.get(it.id)
        items.delete(it.id)
        if (it.type === 'reasoning' && item?.kind === 'reasoning') {
          const meta: ProviderMetadata | undefined = typeof it.encrypted_content === 'string' ? { openai: { encryptedContent: it.encrypted_content } } : undefined
          yield { type: 'reasoning-end', providerMetadata: meta }
        } else if (it.type === 'function_call' && item?.kind === 'tool') {
          sawToolCall = true
          yield { type: 'tool-call', callId: item.callId, name: item.name, input: parseToolInput(item.json) }
        }
        break
      }

      case 'response.completed': {
        sawCompleted = true
        const u = ev.response?.usage ?? {}
        usage.inputTokens = u.input_tokens ?? 0
        usage.outputTokens = u.output_tokens ?? 0
        if (u.input_tokens_details?.cached_tokens != null) usage.cacheReadTokens = u.input_tokens_details.cached_tokens
        if (u.output_tokens_details?.reasoning_tokens != null) usage.reasoningTokens = u.output_tokens_details.reasoning_tokens
        incomplete = ev.response?.incomplete_details?.reason
        break
      }

      case 'response.failed':
        yield errorChunk('model_error', `${ev.response?.error?.code ?? 'error'}: ${ev.response?.error?.message ?? ''}`, true)
        return

      case 'error': // 流已开始（HTTP 200 已发出），错误作为事件到达；瞬时类才可重试
        yield errorChunk('model_error', `${ev.code ?? 'error'}: ${ev.param ?? ''} ${ev.message ?? ''}`.trim(), RETRYABLE_ERR.has(ev.code))
        return

      default: break // response.created / in_progress / content_part.* 等：按文档要求优雅忽略
    }
  }

  if (!sawCompleted) { yield errorChunk('model_error', 'stream ended before response.completed', true); return }
  // 合同要求"有 tool-call 则 finishReason 是 tool-calls"：被截断的参数已是 { __raw }，loop 会把解析失败回给模型。
  if (sawToolCall) { yield { type: 'finish', finishReason: 'tool-calls', usage }; return }
  if (incomplete === 'max_output_tokens') { yield { type: 'finish', finishReason: 'length', usage }; return }
  if (incomplete) { yield { type: 'finish', finishReason: 'other', usage }; return }
  yield { type: 'finish', finishReason: 'stop', usage }
}
