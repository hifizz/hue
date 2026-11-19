// 离线夹具（OpenAI Responses）：按官方文档的事件格式构造字节流，不依赖网络和 key。
// 这些是按文档构造的，不是线上录制；真实流里可能有文档没写的细节。
import type { Json } from '@hue/core'

export type Wire = { type: string; [k: string]: unknown }

const splitStr = (s: string, n: number): string[] => {
  if (s === '') return []
  const out: string[] = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

// ── 事件构造，字段名与官方 streaming-events 参考一致 ──
let seq = 0
export const resetSeq = () => { seq = 0 }
const ev = (type: string, extra: Record<string, unknown> = {}): Wire => ({ type, sequence_number: seq++, ...extra })

export const created = (): Wire => ev('response.created', { response: { id: 'resp_test' } })
export const inProgress = (): Wire => ev('response.in_progress', { response: { id: 'resp_test' } })

export function completed(o: { output?: unknown[]; inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number; incomplete?: string } = {}): Wire {
  const u = {
    input_tokens: o.inputTokens ?? 100, output_tokens: o.outputTokens ?? 1,
    ...(o.cachedTokens != null ? { input_tokens_details: { cached_tokens: o.cachedTokens } } : {}),
    ...(o.reasoningTokens != null ? { output_tokens_details: { reasoning_tokens: o.reasoningTokens } } : {}),
  }
  return ev('response.completed', { response: { id: 'resp_test', usage: u, ...(o.incomplete ? { incomplete_details: { reason: o.incomplete } } : {}) } })
}
export const failed = (code: string, message: string): Wire => ev('response.failed', { response: { error: { code, message } } })

const itemAdded = (outputIndex: number, item: Json) => ev('response.output_item.added', { output_index: outputIndex, item })
const itemDone = (outputIndex: number, item: Json) => ev('response.output_item.done', { output_index: outputIndex, item })

export const textItem = (index: number, text: string, fragment = 6): Wire[] => {
  const id = `msg_${index}`
  return [
    itemAdded(index, { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] }),
    ev('response.content_part.added', { item_id: id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
    ...splitStr(text, fragment).map(t => ev('response.output_text.delta', { item_id: id, output_index: index, content_index: 0, delta: t })),
    ev('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text }),
    ev('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part: { type: 'output_text', text, annotations: [] } }),
    itemDone(index, { id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }),
  ]
}

/** 推理项。无状态模式下 encrypted_content 在 output_item.done 里给全。 */
export const reasoningItem = (index: number, summary: string, encryptedContent: string, fragment = 8): Wire[] => {
  const id = `rs_${index}`
  return [
    itemAdded(index, { id, type: 'reasoning', content: [], summary: [] }),
    ...splitStr(summary, fragment).map(t => ev('response.reasoning_summary_text.delta', { item_id: id, output_index: index, summary_index: 0, delta: t })),
    ev('response.reasoning_summary_text.done', { item_id: id, output_index: index, summary_index: 0, text: summary }),
    itemDone(index, { id, type: 'reasoning', encrypted_content: encryptedContent, content: [], summary: [{ type: 'summary_text', text: summary }] }),
  ]
}

/** input 传字符串时原样当 JSON 文本切碎（可构造被截断的参数）；传对象则先 stringify；{} 输出空串（无参数工具）。 */
export const toolItem = (index: number, callId: string, name: string, input: Json | string, fragment = 5): Wire[] => {
  const id = `fc_${index}`
  const json = typeof input === 'string' ? input : input && Object.keys(input as object).length === 0 ? '' : JSON.stringify(input)
  return [
    itemAdded(index, { id, type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' }),
    ...splitStr(json, fragment).map(d => ev('response.function_call_arguments.delta', { item_id: id, output_index: index, delta: d })),
    ...(json ? [ev('response.function_call_arguments.done', { item_id: id, output_index: index, arguments: json })] : []),
    itemDone(index, { id, type: 'function_call', status: 'completed', call_id: callId, name, arguments: json }),
  ]
}

/** 一条完整回复：created → in_progress → 各 item → completed。[DONE] 哨兵由 toSSEText 追加。 */
export const reply = (items: Wire[][], o: { outputTokens?: number; inputTokens?: number; cachedTokens?: number; reasoningTokens?: number; incomplete?: string } = {}): Wire[] =>
  [created(), inProgress(), ...items.flat(), completed(o)]

// ── 编码成字节并切包（与 anthropic 夹具同构，复用 fixtures.ts 的机制即可，这里只生成文本）──
export const toSSEText = (events: Wire[]): string => `${events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`

export const openaiError = (status: number, message: string, o: { type?: string; code?: string } = {}): Response =>
  new Response(JSON.stringify({ error: { message, type: o.type ?? 'invalid_request_error', code: o.code } }), { status })
