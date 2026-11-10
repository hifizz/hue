import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { RpcMessage } from '../src/mcp/transport.js'
import { createMock } from './mcp-mock.js'
import type { MockOptions } from './mcp-mock.js'

export interface HttpMockOptions extends MockOptions {
  /** 用 SSE 流回答（通知和响应都走流）。 */
  sse?: boolean
  /** 所有请求直接回这个状态码（401 之类）。 */
  status?: number
}
export interface Seen { headers: IncomingHttpHeaders; body: RpcMessage }
export interface HttpMock { url: string; seen: Seen[]; closedByClient: number; sessions: Set<string>; close(): Promise<void> }

const decode = (v: string | undefined) => (v?.startsWith('=?base64?') && v.endsWith('?=') ? Buffer.from(v.slice(9, -2), 'base64').toString('utf8') : v)

export async function httpMock(o: HttpMockOptions = {}): Promise<HttpMock> {
  const mock = createMock(o), seen: Seen[] = [], sessions = new Set<string>()
  let n = 0
  const m: HttpMock = { url: '', seen, closedByClient: 0, sessions, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()) }) }
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcMessage
    seen.push({ headers: req.headers, body })
    res.on('close', () => { if (!res.writableEnded) m.closedByClient++ })
    const reject = (status: number, message: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof message === 'string' ? message : JSON.stringify(message)) }
    if (o.status) return reject(o.status, 'nope', 'text/plain')

    const h = req.headers, legacy = (o.mode ?? 'modern') !== 'modern'
    if (legacy) {
      // 老 server 的做法：没握手就是一个说不清的 400
      if (body.method === 'initialize') { const sid = `sess-${++n}`; sessions.add(sid); res.setHeader('mcp-session-id', sid) }
      else if (!h['mcp-session-id']) return reject(400, 'Bad Request: No valid session ID provided', 'text/plain')
      else if (!sessions.has(h['mcp-session-id'] as string)) return reject(404, 'Session not found', 'text/plain')
    } else {
      const meta = ((body.params ?? {}) as { _meta?: Record<string, unknown> })._meta ?? {}
      const bad = (why: string) => reject(400, { jsonrpc: '2.0', id: body.id, error: { code: -32020, message: `Header mismatch: ${why}` } })
      if (h['mcp-protocol-version'] !== meta['io.modelcontextprotocol/protocolVersion']) return bad('MCP-Protocol-Version')
      if (h['mcp-method'] !== body.method) return bad('Mcp-Method')
      if (body.method === 'tools/call' && decode(h['mcp-name'] as string) !== (body.params as { name: string }).name) return bad('Mcp-Name')
    }

    const outs = mock.handle(body)
    if (body.id === undefined) { res.writeHead(202); return res.end() }
    const send = outs.filter(x => x.type === 'send').map(x => (x as { message: RpcMessage }).message)
    const die = outs.some(x => x.type === 'die'), silent = outs.some(x => x.type === 'none')
    if (o.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' })
      res.write(':\r\n\r\n') // 保活注释
      for (const msg of send) res.write(`event: message\r\ndata: ${JSON.stringify(msg)}\r\n\r\n`)
      if (die) { res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":0,"progress":1}}\r\n\r\n'); setTimeout(() => res.destroy(), 20) } else if (!silent) res.end()
      return
    }
    if (die) return void req.socket.destroy()
    if (silent) return // 一直不回，等客户端关连接
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(send.at(-1)))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  return m
}
