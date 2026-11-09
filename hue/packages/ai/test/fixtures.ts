// 离线夹具：按官方文档的事件格式生成"线上字节"，不需要网络和 API key。
// 注意：这些是按文档构造的，不是线上录制。真实流里可能有文档没写的细节。
import type { Json } from '@hue/core'

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
/** 被遮蔽的推理：没有 delta，加密内容 data 在 start 里一次给全。 */
export const redactedBlock = (index: number, data: string): Wire[] => [
  start(index, { type: 'redacted_thinking', data }),
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

export interface Call { url: string; init: RequestInit; body: any }
export type Step = Response | Error | ((init: RequestInit) => Response | Promise<Response>)

export interface SseOptions { packetSize?: number; status?: number; headers?: Record<string, string>; signal?: AbortSignal; onCancel?: () => void }

/** 200 + SSE 字节流。signal 触发时让流报 AbortError，和真实 fetch 的行为一致。 */
export function sseResponse(events: Wire[], o: SseOptions = {}): Response {
  const it = packets(toSSEText(events), o.packetSize ?? 13)
  const body = new ReadableStream<Uint8Array>({
    start(c) { o.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true }) },
    async pull(c) { const n = await it.next(); if (n.done) c.close(); else c.enqueue(n.value) },
    cancel() { o.onCancel?.(); void it.return(undefined) },
  })
  return new Response(body, { status: o.status ?? 200, headers: { 'content-type': 'text/event-stream', ...o.headers } })
}

/** Anthropic 风格的错误响应。 */
export function errorResponse(status: number, error: { type: string; message: string } | string, headers: Record<string, string> = {}): Response {
  const body = typeof error === 'string' ? error : JSON.stringify({ type: 'error', error, request_id: 'req_test' })
  return new Response(body, { status, headers })
}

/** 按顺序消费 steps；每次调用记一条 Call。steps 用完还被调用就抛错，说明代码多发了请求。 */
export function fakeFetch(steps: Step[]): { fetch: typeof fetch; calls: Call[] } {
  const queue = [...steps]
  const calls: Call[] = []
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    const step = queue.shift()
    if (!step) throw new Error('fakeFetch: script exhausted (more requests than expected)')
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step(init) : step
  }) as typeof fetch
  return { fetch: doFetch, calls }
}
