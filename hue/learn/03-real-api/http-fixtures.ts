// 离线测试用的"假 fetch"：返回的是真正的 Response / ReadableStream，所以整条链路（含 reader.cancel）都是真的。
import { packets, toSSEText, type Wire } from '../02-streaming/fixtures.js'

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
