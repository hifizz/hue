/**
 * Anthropic 的 SSE 事件 → core 的 ModelChunk。
 *
 * 回复被拆成内容块（按 index 编号），每块经历 start → delta × N → stop：
 *   message_start            初始 usage
 *   content_block_start/delta/stop  × 若干块（thinking / text / tool_use）
 *   message_delta            stop_reason + 累计 usage
 *   message_stop
 *
 * 为什么 tool_use 要攒到 stop 才发：partial_json 单独拿出来（`{"cit`）不是合法 JSON，拼完才是。
 * 为什么 thinking 的 signature 要存到 stop 才发：它在 stop 之前才到，而且丢了下一轮会 400。
 */
import type { FinishReason, HueError, Json, ModelChunk, ProviderMetadata, Usage } from '@hue/core'
import type { SSEMessage } from './sse.js'

type OpenBlock =
  | { kind: 'text' }
  | { kind: 'thinking'; signature?: string; redactedData?: string }
  | { kind: 'tool'; callId: string; name: string; json: string }
  | { kind: 'ignored' } // 不认识的块类型（server_tool_use 等）：安静跳过，不要崩

export const SOURCE = 'ai:anthropic'
export const errorChunk = (code: HueError['code'], message: string, retryable: boolean): ModelChunk =>
  ({ type: 'error', error: { code, message, retryable, source: SOURCE } })

export async function* toChunks(events: AsyncIterable<SSEMessage>): AsyncGenerator<ModelChunk> {
  const blocks = new Map<number, OpenBlock>()
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: string | undefined
  let sawStop = false, sawToolCall = false

  for await (const sse of events) {
    let ev: any
    try { ev = JSON.parse(sse.data) } catch { yield errorChunk('model_error', `bad JSON in event "${sse.event}"`, false); return }

    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage ?? {}
        usage.inputTokens = u.input_tokens ?? 0
        usage.outputTokens = u.output_tokens ?? 0
        if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens
        if (u.cache_creation_input_tokens != null) usage.cacheWriteTokens = u.cache_creation_input_tokens
        break
      }

      case 'content_block_start': {
        const b = ev.content_block
        if (b.type === 'text') blocks.set(ev.index, { kind: 'text' })
        else if (b.type === 'thinking') blocks.set(ev.index, { kind: 'thinking' })
        // redacted_thinking 没有 delta，加密内容在 start 里一次给全；必须存下来原样发回。
        else if (b.type === 'redacted_thinking') blocks.set(ev.index, { kind: 'thinking', redactedData: b.data })
        else if (b.type === 'tool_use') blocks.set(ev.index, { kind: 'tool', callId: b.id, name: b.name, json: '' }) // start 里的 input 永远是 {}
        else blocks.set(ev.index, { kind: 'ignored' })
        break
      }

      case 'content_block_delta': {
        const block = blocks.get(ev.index)
        const d = ev.delta
        if (!block) break
        if (d.type === 'text_delta' && block.kind === 'text') yield { type: 'text-delta', text: d.text }
        else if (d.type === 'thinking_delta' && block.kind === 'thinking') yield { type: 'reasoning-delta', text: d.thinking }
        else if (d.type === 'signature_delta' && block.kind === 'thinking') block.signature = d.signature
        else if (d.type === 'input_json_delta' && block.kind === 'tool') {
          block.json += d.partial_json
          yield { type: 'tool-input-delta', callId: block.callId, name: block.name, delta: d.partial_json } // 只给 UI
        }
        break
      }

      case 'content_block_stop': {
        const block = blocks.get(ev.index)
        blocks.delete(ev.index)
        if (block?.kind === 'thinking') {
          const meta: ProviderMetadata | undefined = block.signature ? { anthropic: { signature: block.signature } }
            : block.redactedData != null ? { anthropic: { redactedData: block.redactedData } } : undefined
          yield { type: 'reasoning-end', providerMetadata: meta }
        } else if (block?.kind === 'tool') {
          sawToolCall = true
          yield { type: 'tool-call', callId: block.callId, name: block.name, input: parseToolInput(block.json) }
        }
        break
      }

      case 'message_delta':
        stopReason = ev.delta?.stop_reason ?? stopReason
        // 文档明确警告：这里的 usage 是累计值，覆盖而不是累加。
        if (ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens
        break

      case 'message_stop':
        sawStop = true
        break

      case 'error': // 流已开始（HTTP 200 已发出），所以错误是事件，不是状态码
        yield errorChunk('model_error', `${ev.error?.type}: ${ev.error?.message}`,
          ['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error'].includes(ev.error?.type))
        return

      default: break // ping 以及将来新增的事件：文档要求优雅忽略
    }
  }

  // 没看到 message_stop 就断了：不能当正常结束，否则会把截断的回复当成完整回复。
  if (!sawStop) { yield errorChunk('model_error', 'stream ended before message_stop', true); return }
  // 合同要求"有 tool-call 则 finishReason 是 tool-calls"。max_tokens 截断工具参数时也走这条：
  // 截断的参数已经是 { __raw }，loop 会把"参数不是合法 JSON"回给模型，让它换短参数重试。
  yield { type: 'finish', finishReason: sawToolCall ? 'tool-calls' : mapStopReason(stopReason), usage }
}

/** 空串 = 无参数工具（一个 input_json_delta 都没来），等价 {}。解析失败（多半是被 max_tokens 截断）包成 { __raw }。 */
export function parseToolInput(raw: string): Json {
  if (raw.trim() === '') return {}
  try { return JSON.parse(raw) } catch { return { __raw: raw } }
}

function mapStopReason(r: string | undefined): FinishReason {
  switch (r) {
    case 'end_turn': case 'stop_sequence': return 'stop'
    case 'tool_use': return 'tool-calls'
    case 'max_tokens': case 'model_context_window_exceeded': return 'length'
    case 'refusal': return 'content-filter'
    default: return 'other' // pause_turn（服务端工具循环到上限）等：暂不处理
  }
}
