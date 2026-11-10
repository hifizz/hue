import { abortError, TransportError } from './transport.js'
import type { Reply, RequestOptions, RpcMessage, Transport } from './transport.js'

export interface HttpOptions {
  /** 认证等固定头。 */
  headers?: Record<string, string>
  fetch?: typeof fetch
}

/** SSE 流里的 data 行 → JSON-RPC 报文。注释行（以冒号开头的保活）和别的字段忽略。 */
async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<RpcMessage> {
  const reader = body.getReader(), dec = new TextDecoder()
  let buf = ''
  const parse = (block: string) => {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
    return data ? (JSON.parse(data) as RpcMessage) : undefined
  }
  for (;;) {
    const { done, value } = await reader.read()
    buf += dec.decode(value, { stream: !done })
    for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
      const msg = parse(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length)
      if (msg) yield msg
    }
    if (done) { const msg = buf.trim() ? parse(buf) : undefined; if (msg) yield msg; return }
  }
}

/** Streamable HTTP：每条消息一个 POST，响应是一个 JSON 或一条只属于这次请求的 SSE 流。 */
export function httpTransport(url: string, o: HttpOptions = {}): Transport {
  const doFetch = o.fetch ?? fetch
  const post = (msg: RpcMessage, headers: Record<string, string> | undefined, signal?: AbortSignal) =>
    doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...o.headers, ...headers }, body: JSON.stringify(msg), signal })

  return {
    kind: 'http',
    async request(msg, ro: RequestOptions): Promise<Reply> {
      // 关掉响应流就是取消（规范）；fetch 的 signal 做的正是这件事。
      let res: Response
      try { res = await post(msg, ro.headers, ro.signal) } catch (e) { throw ro.signal.aborted ? abortError() : new TransportError(`request failed: ${(e as Error).message}`) }
      const type = res.headers.get('content-type') ?? ''
      try {
        if (type.includes('text/event-stream') && res.ok) {
          for await (const m of sseMessages(res.body!)) {
            if (m.id === msg.id && (m.result || m.error)) { await res.body!.cancel().catch(() => {}); return { message: m, status: res.status, headers: res.headers } }
            if (m.method) ro.onNotification?.(m)
          }
          throw new TransportError('response stream ended before the result arrived')
        }
        const text = await res.text()
        let message: RpcMessage | undefined
        try { const j = JSON.parse(text); message = j && typeof j === 'object' && !Array.isArray(j) ? j : undefined } catch { /* 不是 JSON：可能是 HTML 错误页 */ }
        return { message, status: res.status, headers: res.headers }
      } catch (e) {
        if (ro.signal.aborted) throw abortError()
        throw e instanceof TransportError ? e : new TransportError(`response stream broke: ${(e as Error).message}`)
      }
    },
    async notify(msg, no) { try { await (await post(msg, no?.headers)).body?.cancel() } catch { /* 通知丢了不影响正确性 */ } },
    async close() {},
  }
}
