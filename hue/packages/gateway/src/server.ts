import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { HueEvent, InputResponse } from '@hue/core'
import { authenticate, checkHost, checkOrigin, createLimiter, HttpError, LOOPBACK } from './auth.js'
import { createHub } from './hub.js'
import { createInputs } from './inputs.js'
import type { Channel, Gateway, GatewayOptions } from './types.js'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CHANNEL_NAME = /^[a-z0-9-]{1,20}$/
const LOOPBACK_BINDS = ['127.0.0.1', 'localhost', '::1']
const MAX_TEXT = 100_000

const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store', ...headers })
  res.end(s)
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json')
  // 声明的长度超了就不读：能干净地回 413。分块传输没有声明，读超了只能断连接。
  if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, 'body_too_large', `body is larger than ${max} bytes`, { connection: 'close' })
  const chunks: Buffer[] = []; let n = 0
  for await (const c of req as AsyncIterable<Buffer>) { n += c.length; if (n > max) throw new HttpError(413, 'body_too_large', `body is larger than ${max} bytes`, { connection: 'close' }); chunks.push(c) }
  return Buffer.concat(chunks).toString('utf8')
}
const parseJson = (raw: string): unknown => { try { return JSON.parse(raw) } catch { throw new HttpError(400, 'invalid_json', 'body is not valid JSON') } }

const textOf = (e: Extract<HueEvent, { type: 'model.message' }>) => e.message.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('')

function parseResponse(b: unknown): InputResponse | undefined {
  const r = b as { action?: unknown; value?: unknown; reason?: unknown } | null
  if (r?.action === 'accept') return r.value === undefined ? { action: 'accept' } : { action: 'accept', value: r.value as never }
  if (r?.action === 'decline') return typeof r.reason === 'string' ? { action: 'decline', reason: r.reason } : { action: 'decline' }
  return r?.action === 'cancel' ? { action: 'cancel' } : undefined
}

const conversationKey = (c: string) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(c) ? c : `h-${createHash('sha256').update(c).digest('hex').slice(0, 32)}`)

export function createGateway(o: GatewayOptions): Gateway {
  const tokens = o.tokens?.length ? o.tokens : undefined
  if (!tokens && !o.insecureNoAuth) throw new Error('gateway needs `tokens`, or `insecureNoAuth: true` for local development')
  if (tokens?.some(t => t.length < 16)) throw new Error('tokens must be at least 16 characters')
  const channels = new Map<string, Channel>()
  for (const c of o.channels ?? []) {
    if (!CHANNEL_NAME.test(c.name)) throw new Error(`channel name "${c.name}" must be 1-20 lowercase letters, digits or hyphens`)
    if (channels.has(c.name)) throw new Error(`duplicate channel "${c.name}"`)
    channels.set(c.name, c)
  }
  const now = o.now ?? Date.now
  const maxBody = o.maxBodyBytes ?? 1 << 20, maxRuns = o.maxRuns ?? 8, keepAliveMs = o.keepAliveMs ?? 15_000
  const maxStreams = o.maxStreams ?? 100, closeTimeoutMs = o.closeTimeoutMs ?? 10_000
  const allowedHosts = (o.allowedHosts ?? LOOPBACK).map(h => h.toLowerCase()), allowedOrigins = o.allowedOrigins ?? []
  const limit = createLimiter(o.rateLimitPerMinute ?? 120, now)
  const hub = createHub(), inputs = createInputs(o.inputTimeoutMs ?? 600_000)
  const agent = typeof o.agent === 'function' ? o.agent(inputs.port) : o.agent
  const running = new Map<string, Promise<void>>(), streams = new Set<ServerResponse>()
  const shutdown = new AbortController()
  let server: Server | undefined, closing = false

  const ext = (sessionId: string, message: string): HueEvent =>
    ({ v: 1, id: randomUUID(), sessionId, seq: 0, at: now(), type: 'ext', name: 'gateway.error', durable: false, data: { message } })

  async function tell(ch: Channel, conversation: string, text: string, sessionId: string) {
    try { await ch.reply(conversation, text) } catch (err) { hub.publish(sessionId, ext(sessionId, `channel "${ch.name}" could not send a reply: ${(err as Error).message}`)) }
  }

  /** 在后台跑一个 turn（和它之后因插话续上的 turn），事件原样转给订阅者。调用方已经检查过没有同名会话在跑。 */
  function start(sessionId: string, text: string, ch?: { channel: Channel; conversation: string }) {
    let done!: () => void
    running.set(sessionId, new Promise<void>(r => { done = r }))
    void (async () => {
      let last = ''
      try {
        for await (const e of agent.run(text, { sessionId, signal: shutdown.signal })) {
          hub.publish(sessionId, e)
          if (!ch) continue
          if (e.type === 'turn.started') last = ''
          else if (e.type === 'model.message') last = textOf(e)
          else if (e.type === 'turn.ended') await tell(ch.channel, ch.conversation, e.reason === 'stop' ? last || '(no reply)' : `${last}\n\n(stopped: ${e.reason})`.trim(), sessionId)
        }
      } catch (err) {
        hub.publish(sessionId, ext(sessionId, (err as Error).message))
        // 平台上的用户看不到内部错误信息，只告诉他出错了
        if (ch) await tell(ch.channel, ch.conversation, 'Sorry, something went wrong on my side.', sessionId)
      } finally { running.delete(sessionId); done() }
    })()
  }

  function deliver(sessionId: string, text: string, ch?: { channel: Channel; conversation: string }): 'started' | 'steered' {
    if (running.has(sessionId)) {
      if (agent.steer(sessionId, text)) return 'steered'
      throw new HttpError(409, 'session_finishing', 'the session is just finishing; retry in a moment', { 'retry-after': '1' })
    }
    if (running.size >= maxRuns) throw new HttpError(429, 'too_many_runs', `${maxRuns} sessions are already running`, { 'retry-after': '5' })
    start(sessionId, text, ch)
    return 'started'
  }

  async function stream(req: IncomingMessage, res: ServerResponse, sessionId: string, url: URL, cors: Record<string, string>) {
    const raw = url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0'
    const after = Number(raw)
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'invalid_after', '`after` / Last-Event-ID must be a non-negative integer')
    if (streams.size >= maxStreams) throw new HttpError(429, 'too_many_streams', `${maxStreams} event streams are already open`, { 'retry-after': '5' })

    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    streams.add(res)
    let last = after, live = false
    const buffered: HueEvent[] = []
    // durable 事件按 seq 去重：回放和实时可能给同一个事件。临时事件（delta、progress）只有实时，没有 seq。
    const write = (e: HueEvent) => {
      if (res.writableEnded) return
      if (e.seq > 0) { if (e.seq <= last) return; last = e.seq }
      res.write(`${e.seq > 0 ? `id: ${e.seq}\n` : ''}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    }
    // 先订阅再回放：回放期间到的事件先攒着，回放完同步地冲掉再切到实时，中间没有空隙。
    const unsubscribe = hub.subscribe(sessionId, e => (live ? write(e) : buffered.push(e)))
    const timer = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n') }, keepAliveMs)
    res.on('close', () => { clearInterval(timer); unsubscribe(); streams.delete(res) })
    res.write(': stream open\n\n')
    try {
      for await (const e of o.store.read(sessionId, { fromSeq: after + 1 })) { if (res.destroyed) return; write(e) }
    } catch (err) {
      res.write(`event: gateway.error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`); res.end(); return
    }
    for (const e of buffered) write(e)
    live = true
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname, method = req.method ?? 'GET'
    let cors: Record<string, string> = {}
    try {
      if (path === '/healthz' && method === 'GET') return reply(res, 200, { ok: true }) // 探活不查 Host，也不暴露任何信息
      checkHost(req.headers, allowedHosts)
      const origin = checkOrigin(req.headers, allowedOrigins)
      if (origin) cors = { 'access-control-allow-origin': origin, vary: 'Origin' }
      if (method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, last-event-id', 'access-control-max-age': '600' })
        return void res.end()
      }
      if (closing) throw new HttpError(503, 'shutting_down', 'the gateway is shutting down')

      const only = (m: string) => { if (method !== m) throw new HttpError(405, 'method_not_allowed', `use ${m}`, { allow: m }) }

      const c = /^\/channels\/([^/]+)$/.exec(path)
      if (c) {
        const channel = channels.get(c[1]!)
        if (!channel) throw new HttpError(404, 'not_found', 'no such channel')
        only('POST')
        const rawBody = await readBody(req, maxBody)
        // 先验签再解析、再限流：没通过签名的请求不消耗这个渠道的配额，也不会让平台被自己人的垃圾流量限流
        if (!channel.verify(req.headers, rawBody)) throw new HttpError(401, 'bad_signature', 'signature check failed')
        limit(`channel:${channel.name}`)
        const msg = channel.parse(parseJson(rawBody))
        if (!msg) return reply(res, 200, { status: 'ignored' }, cors)
        const sessionId = `${channel.name}:${conversationKey(msg.conversation)}`
        return reply(res, 202, { status: deliver(sessionId, msg.text.slice(0, MAX_TEXT), { channel, conversation: msg.conversation }), sessionId }, cors)
      }

      limit(authenticate(req.headers, tokens))
      const m = /^\/v1\/sessions\/([^/]+)(?:\/(messages|events|interrupt)|\/inputs\/([^/]+))?$/.exec(path)
      if (!m) throw new HttpError(404, 'not_found', 'no such route')
      let sessionId: string
      try { sessionId = decodeURIComponent(m[1]!) } catch { sessionId = '' }
      if (!SESSION_ID.test(sessionId)) throw new HttpError(400, 'invalid_session_id', 'session id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}')

      if (m[3] !== undefined) {
        only('POST')
        const response = parseResponse(parseJson(await readBody(req, maxBody)))
        if (!response) throw new HttpError(400, 'invalid_response', '`action` must be accept, decline or cancel')
        if (!inputs.answer(sessionId, decodeURIComponent(m[3]), response)) throw new HttpError(404, 'no_such_request', 'no pending input request with this id in this session')
        return reply(res, 200, { status: 'answered' }, cors)
      }
      switch (m[2]) {
        case 'messages': {
          only('POST')
          const text = (parseJson(await readBody(req, maxBody)) as { text?: unknown } | null)?.text
          if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'invalid_text', '`text` must be a non-empty string')
          if (text.length > MAX_TEXT) throw new HttpError(413, 'text_too_long', `\`text\` is longer than ${MAX_TEXT} characters`)
          return reply(res, 202, { status: deliver(sessionId, text), sessionId }, cors)
        }
        case 'events': only('GET'); return await stream(req, res, sessionId, url, cors)
        case 'interrupt':
          only('POST')
          if (!running.has(sessionId) || !agent.interrupt(sessionId)) throw new HttpError(409, 'not_running', 'the session has no running turn')
          return reply(res, 202, { status: 'interrupting' }, cors)
        default: {
          only('GET')
          const lastSeq = await o.store.lastSeq(sessionId), isRunning = running.has(sessionId)
          if (!lastSeq && !isRunning) throw new HttpError(404, 'not_found', 'no such session')
          return reply(res, 200, { sessionId, running: isRunning, lastSeq, pendingInputs: inputs.pendingFor(sessionId) }, cors)
        }
      }
    } catch (err) {
      if (res.headersSent) return void res.end()
      if (err instanceof HttpError) return reply(res, err.status, { error: { code: err.code, message: err.message } }, { ...cors, ...err.headers })
      o.onError?.(err)
      reply(res, 500, { error: { code: 'internal', message: 'internal error' } }, cors)
    }
  }

  return {
    inputPort: inputs.port,
    handler: (req, res) => void handle(req, res),
    async listen(port = 0, host = '127.0.0.1') {
      if (!tokens && !LOOPBACK_BINDS.includes(host)) throw new Error(`refusing to listen on ${host} without tokens: insecureNoAuth is for loopback only`)
      if (!LOOPBACK_BINDS.includes(host) && !o.allowedHosts) throw new Error(`listening on ${host}: set allowedHosts to the host names clients will use (DNS-rebinding protection)`)
      server = createServer((req, res) => void handle(req, res))
      await new Promise<void>((ok, fail) => { server!.once('error', fail); server!.listen(port, host, ok) })
      const p = (server.address() as { port: number }).port
      return { url: `http://${host.includes(':') ? `[${host}]` : host}:${p}`, port: p }
    },
    async close() {
      closing = true
      const stopped = server ? new Promise<void>(r => server!.close(() => r())) : Promise.resolve()
      inputs.cancelAll()
      shutdown.abort()
      // 打断靠 shutdown 的 signal（run 收到的）；先等会话收尾再关事件流：订阅者能收到被打断的 turn.ended。不理会打断的 agent 不能让关闭一直挂着。
      await Promise.race([Promise.all(running.values()), new Promise(r => setTimeout(r, closeTimeoutMs).unref())])
      for (const s of streams) s.end()
      server?.closeAllConnections()
      await stopped
    },
  }
}

