/**
 * 第三层：Hue 的 ModelChunk 流 ← Anthropic SSE 事件流。
 *
 * Anthropic 把一条回复拆成若干"内容块"（content block），每块按下标 index 编号，
 * 每块经历 start → delta × N → stop 三个阶段：
 *
 *   message_start                          带初始 usage（input_tokens、cache 数据）
 *   content_block_start  index=0 thinking
 *   content_block_delta  index=0 thinking_delta   × N
 *   content_block_delta  index=0 signature_delta  × 1   ← 签名在 stop 之前才到
 *   content_block_stop   index=0
 *   content_block_start  index=1 text
 *   content_block_delta  index=1 text_delta × N
 *   content_block_stop   index=1
 *   content_block_start  index=2 tool_use {id, name, input: {}}   ← input 此刻是空对象，别当真
 *   content_block_delta  index=2 input_json_delta × N              ← partial_json 是 JSON 的"片段"
 *   content_block_stop   index=2                                   ← 到这里才能 JSON.parse
 *   message_delta        stop_reason + 累计 usage
 *   message_stop
 *
 * 为什么 tool_use 要攒到 stop 才能解析：partial_json 片段可能是 `{"location":` 或 ` "San Fran`，
 * 单独拿出来都不是合法 JSON。只有全部拼起来才是。
 */
import type { FinishReason, Json, ModelChunk, ProviderMetadata, Usage } from '@hue/core'
import { emptyUsage } from '@hue/core'
import type { SSEMessage } from './sse.js'

/** 每个正在进行的内容块，在 stop 之前要记住什么。 */
type OpenBlock =
  | { kind: 'text' }
  | { kind: 'thinking'; signature?: string }
  | { kind: 'tool'; callId: string; name: string; json: string }
  | { kind: 'ignored' } // 不认识的块类型（比如 server_tool_use）：安静地跳过，不要崩

export async function* toModelChunks(events: AsyncIterable<SSEMessage>): AsyncGenerator<ModelChunk> {
  const blocks = new Map<number, OpenBlock>()
  const usage: Usage = emptyUsage()
  let stopReason: string | undefined
  let sawStop = false

  for await (const sse of events) {
    let ev: any
    try { ev = JSON.parse(sse.data) } catch { yield badEvent(`bad JSON in event "${sse.event}"`); return }

    switch (ev.type) {
      case 'message_start': {
        // 输入侧的 token 数在这里给；输出侧在 message_delta 里累计。
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
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') blocks.set(ev.index, { kind: 'thinking' })
        else if (b.type === 'tool_use') blocks.set(ev.index, { kind: 'tool', callId: b.id, name: b.name, json: '' })
        else blocks.set(ev.index, { kind: 'ignored' })
        break
      }

      case 'content_block_delta': {
        const block = blocks.get(ev.index)
        const d = ev.delta
        if (!block) break // 没见过 start 的 delta：忽略，不崩
        if (d.type === 'text_delta' && block.kind === 'text') yield { type: 'text-delta', text: d.text }
        else if (d.type === 'thinking_delta' && block.kind === 'thinking') yield { type: 'reasoning-delta', text: d.thinking }
        else if (d.type === 'signature_delta' && block.kind === 'thinking') block.signature = d.signature // 先存着，stop 时一起发
        else if (d.type === 'input_json_delta' && block.kind === 'tool') {
          block.json += d.partial_json
          yield { type: 'tool-input-delta', callId: block.callId, name: block.name, delta: d.partial_json } // 只给 UI 看
        }
        break
      }

      case 'content_block_stop': {
        const block = blocks.get(ev.index)
        blocks.delete(ev.index)
        if (block?.kind === 'thinking') {
          // 签名必须带上，否则下一轮这个推理块发回去会被拒绝。
          const meta: ProviderMetadata | undefined = block.signature ? { anthropic: { signature: block.signature } } : undefined
          yield { type: 'reasoning-end', providerMetadata: meta }
        } else if (block?.kind === 'tool') {
          yield { type: 'tool-call', callId: block.callId, name: block.name, input: parseToolInput(block.json) }
        }
        break
      }

      case 'message_delta': {
        stopReason = ev.delta?.stop_reason ?? stopReason
        // 文档明确警告：这里的 usage 是"累计值"，所以直接覆盖，不是累加。
        if (ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens
        break
      }

      case 'message_stop':
        sawStop = true
        break

      case 'error':
        // 流已经开始（HTTP 200 已发出），所以错误是作为事件来的，不是 HTTP 状态码。
        yield badEvent(`${ev.error?.type}: ${ev.error?.message}`)
        return

      // ping（保活）以及将来新增的事件类型：文档要求"优雅忽略"。
      default:
        break
    }
  }

  // 没看到 message_stop 就断了：不能当成正常结束，否则会把截断的回复当成完整回复。
  if (!sawStop) { yield badEvent('stream ended before message_stop'); return }
  yield { type: 'finish', finishReason: mapStopReason(stopReason), usage }
}

const badEvent = (message: string): ModelChunk => ({
  type: 'error',
  error: { code: 'model_error', message, source: 'ai:anthropic' },
})

/**
 * 解析工具参数。
 * - 空串：没有参数的工具（input_json_delta 一个都没来），等价于 {}。
 * - 解析失败：通常是 max_tokens 把参数截断了。不抛错，把原文包起来交给 loop，
 *   由 loop 把"参数不是合法 JSON"作为错误结果回给模型。
 */
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
    // pause_turn：服务端工具循环到上限，需要把内容发回去继续。最小实现不处理，归为 other。
    default: return 'other'
  }
}
