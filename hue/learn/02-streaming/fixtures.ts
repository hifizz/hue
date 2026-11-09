// 离线夹具：用官方文档里的 Anthropic 事件格式生成"线上字节"，不需要网络和 API key。
// 两个假模型：
//   wireModel  ：从 Anthropic 事件 → 编码成字节 → 任意切包 → 走完整链路（parseSSE → toChunks）
//   chunkModel ：直接给 Chunk，只测 loop 本身
import type { Chunk, Json, ModelRequest, StreamingModel } from './types.js'
import { parseSSE } from './sse.js'
import { toChunks } from './anthropic.js'

export type Wire = { type: string; [k: string]: unknown }

const splitStr = (s: string, n: number): string[] => {
  if (s === '') return [''] // 官方例子里无参数的工具就是发一个空的 partial_json
  const out: string[] = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

// ── 事件构造，字段名与官方文档一致 ──
export const messageStart = (inputTokens = 100, extraUsage: Record<string, number> = {}): Wire => ({
  type: 'message_start',
  message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1, ...extraUsage } },
})
export const ping = (): Wire => ({ type: 'ping' })
export const messageDelta = (stopReason: string, outputTokens: number): Wire => ({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })
export const messageStop = (): Wire => ({ type: 'message_stop' })

const start = (index: number, content_block: Json): Wire => ({ type: 'content_block_start', index, content_block })
const delta = (index: number, d: Json): Wire => ({ type: 'content_block_delta', index, delta: d })
const stop = (index: number): Wire => ({ type: 'content_block_stop', index })

export const textBlock = (index: number, text: string, fragment = 6): Wire[] => [
  start(index, { type: 'text', text: '' }),
  ...splitStr(text, fragment).map(t => delta(index, { type: 'text_delta', text: t })),
  stop(index),
]
export const thinkingBlock = (index: number, thinking: string, signature: string, fragment = 8): Wire[] => [
  start(index, { type: 'thinking', thinking: '' }),
  ...splitStr(thinking, fragment).map(t => delta(index, { type: 'thinking_delta', thinking: t })),
  delta(index, { type: 'signature_delta', signature }), // 签名在 stop 之前才到
  stop(index),
]
/** input 传字符串时原样当 JSON 文本切碎（可用来构造被截断的 JSON）；传对象则先 stringify。 */
export const toolBlock = (index: number, id: string, name: string, input: Json | string, fragment = 5): Wire[] => {
  const json = typeof input === 'string' ? input : input && Object.keys(input as object).length === 0 ? '' : JSON.stringify(input)
  return [
    start(index, { type: 'tool_use', id, name, input: {} }), // 注意：start 里的 input 永远是空对象
    ...splitStr(json, fragment).map(p => delta(index, { type: 'input_json_delta', partial_json: p })),
    stop(index),
  ]
}

/** 一条完整回复：message_start → ping → 各内容块 → message_delta → message_stop */
export const reply = (blocks: Wire[][], stopReason: string, outputTokens: number, inputTokens = 100): Wire[] =>
  [messageStart(inputTokens), ping(), ...blocks.flat(), messageDelta(stopReason, outputTokens), messageStop()]

// ── 编码成字节并切包 ──
export const toSSEText = (events: Wire[]): string => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

export async function* packets(text: string, packetSize: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  // 按"字节"切，所以会把多字节的中文切成两半，这正是真实网络的行为。
  for (let i = 0; i < bytes.length; i += packetSize) {
    signal?.throwIfAborted()
    await Promise.resolve() // 让出一次，模拟网络到达的异步性
    yield bytes.slice(i, i + packetSize)
  }
}

export interface Recorded { requests: ModelRequest[] }

/** script 的第 N 项是第 N 次模型调用要回放的事件。事件列表可以故意不完整（没有 message_stop）来模拟断流。 */
export function wireModel(script: Wire[][], packetSize = 11): StreamingModel & Recorded {
  const queue = [...script]
  const requests: ModelRequest[] = []
  return {
    requests,
    stream(request, signal) {
      requests.push({ ...request, messages: request.messages.slice() })
      const events = queue.shift()
      if (!events) throw new Error('script exhausted')
      return toChunks(parseSSE(packets(toSSEText(events), packetSize, signal)))
    },
  }
}

export function chunkModel(script: Chunk[][]): StreamingModel & Recorded {
  const queue = [...script]
  const requests: ModelRequest[] = []
  return {
    requests,
    async *stream(request, signal) {
      requests.push({ ...request, messages: request.messages.slice() })
      const chunks = queue.shift()
      if (!chunks) throw new Error('script exhausted')
      for (const c of chunks) { signal.throwIfAborted(); yield c }
    },
  }
}
