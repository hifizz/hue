import { request } from 'node:http'
import type { EventStore, HueEvent, InputPort } from '@hue/core'
import type { AgentLike, GatewayOptions } from '../src/index.js'
import { createGateway } from '../src/index.js'

export const TOKEN = 'test-token-0123456789'

export function memStore(): EventStore & { events: HueEvent[]; failLastSeq?: boolean } {
  const events: HueEvent[] = []
  const s = {
    specVersion: 'hue.store.v1' as const, events, failLastSeq: false,
    async append(es: HueEvent[]) { events.push(...es) },
    async *read(sessionId: string, opts?: { fromSeq?: number }) { for (const e of events) if (e.sessionId === sessionId && e.seq >= (opts?.fromSeq ?? 1)) yield e },
    async lastSeq(sessionId: string) { if (s.failLastSeq) throw new Error('db exploded: secret-connection-string'); return events.filter(e => e.sessionId === sessionId).length },
  }
  return s
}

/**
 * 假 agent：像 runtime 一样"先落盘再 yield"。行为由输入文本决定：
 *   hello  一个 turn，回 "hi back"（带一个只在实时流里有的 delta）
 *   slow   等到 release() 才结束；等待期间收到的插话记成 steer 事件；被打断则以 interrupted 结束
 *   ask    向 InputPort 要批准，按答案回复
 *   boom   抛错
 *   deaf   不理打断，永远不结束
 */
export function fakeAgent(store: ReturnType<typeof memStore>, o: { input?: InputPort; noSteer?: boolean } = {}) {
  const active = new Map<string, { ac: AbortController; steers: string[]; wake: () => void }>()
  const releases = new Map<string, () => void>()
  let n = 0
  const agent: AgentLike & { release(id: string): void; active: typeof active; runs: string[] } = {
    active, runs: [],
    release: id => releases.get(id)?.(),
    async *run(input, { sessionId, signal }) {
      if (active.has(sessionId)) throw new Error('session already has a running turn')
      const me = { ac: new AbortController(), steers: [] as string[], wake: () => {} }
      active.set(sessionId, me)
      agent.runs.push(input)
      const sig = signal ? AbortSignal.any([signal, me.ac.signal]) : me.ac.signal
      const turnId = `t${++n}`
      const emit = async (type: string, fields: object, durable = true) => {
        const seq = durable ? (await store.lastSeq(sessionId)) + 1 : 0
        const e = { v: 1, id: `e${++n}`, sessionId, seq, at: 1, turnId, type, ...fields } as unknown as HueEvent
        if (durable) await store.append([e])
        return e
      }
      const say = (text: string) => emit('model.message', { message: { role: 'assistant', content: [{ type: 'text', text }] }, modelId: 'fake', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })
      const end = (reason: string) => emit('turn.ended', { reason, usage: { inputTokens: 0, outputTokens: 0 }, steps: 1 })
      try {
        yield await emit('turn.started', {})
        yield await emit('user.message', { message: { role: 'user', content: [{ type: 'text', text: input }] } })
        if (input === 'boom') throw new Error('kaboom')
        if (input === 'deaf') await new Promise(() => {})
        if (input === 'ask') {
          const requestId = `req-${++n}`
          yield await emit('input.requested', { requestId, request: { kind: 'approval', prompt: 'Allow it?' } })
          const r = await o.input!.request({ kind: 'approval', prompt: 'Allow it?', requestId, sessionId }, sig)
          yield await emit('input.resolved', { requestId, response: r })
          yield await say(`answer:${r.action}${r.action === 'accept' && r.value !== undefined ? `:${JSON.stringify(r.value)}` : ''}${r.action === 'decline' && r.reason ? `:${r.reason}` : ''}`)
          yield await end('stop'); return
        }
        if (input === 'slow') {
          let released = false
          const done = new Promise<void>(r => releases.set(sessionId, () => { released = true; r() }))
          for (;;) {
            await Promise.race([done, new Promise<void>(r => { me.wake = r; sig.addEventListener('abort', () => r(), { once: true }) })])
            for (const s of me.steers.splice(0)) yield await emit('user.message', { steer: true, message: { role: 'user', content: [{ type: 'text', text: s }] } })
            if (sig.aborted) { yield await end('interrupted'); return }
            if (released) break
          }
          yield await say('slow done'); yield await end('stop'); return
        }
        yield await emit('model.delta', { kind: 'text', delta: 'hi' }, false)
        yield await say(input === 'hello' ? 'hi back' : `echo:${input}`)
        yield await end('stop')
      } finally { active.delete(sessionId) }
    },
    steer(id, text) {
      const a = active.get(id)
      if (!a || o.noSteer) return false
      a.steers.push(text); a.wake(); return true
    },
    interrupt(id) { const a = active.get(id); a?.ac.abort(); return !!a },
  }
  return agent
}

export async function boot(over: Partial<GatewayOptions> = {}, agentOpts: { noSteer?: boolean } = {}) {
  const store = memStore()
  let real!: ReturnType<typeof fakeAgent>
  const gateway = createGateway({ store, tokens: [TOKEN], ...over, agent: input => (real = fakeAgent(store, { input, ...agentOpts })) })
  const { url } = await gateway.listen(0)
  return { gateway, store, agent: real, url, close: () => gateway.close() }
}

export const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
export const post = (url: string, body: unknown, headers: Record<string, string> = auth) => fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
export const send = (base: string, id: string, text: string) => post(`${base}/v1/sessions/${id}/messages`, { text })

export interface Sse { events: Array<{ id?: string; event: string; data: any }>; comments: string[]; waitFor(pred: (e: Sse['events'][number]) => boolean, ms?: number): Promise<Sse['events'][number]>; closed: Promise<void>; close(): void }

/** 打开一个 SSE 流，把收到的事件攒起来。 */
export async function openStream(url: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Sse & { status: number }> {
  const ac = new AbortController()
  const res = await fetch(url, { headers, signal: ac.signal })
  const s: Sse & { status: number } = { status: res.status, events: [], comments: [], closed: Promise.resolve(), close: () => ac.abort(), waitFor: async () => { throw new Error('unset') } }
  if (res.status !== 200 || !res.body) return s
  const waiters: Array<() => void> = []
  s.closed = (async () => {
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true })
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          if (block.startsWith(':')) { s.comments.push(block); continue }
          const f = Object.fromEntries(block.split('\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]))
          s.events.push({ ...(f.id !== undefined && { id: f.id }), event: f.event ?? '', data: JSON.parse(f.data ?? 'null') })
        }
        waiters.splice(0).forEach(w => w())
      }
    } catch { /* 被 close() 中止 */ }
    waiters.splice(0).forEach(w => w())
  })()
  s.waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now()
    for (;;) {
      const hit = s.events.find(pred); if (hit) return hit
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for an event; got ${JSON.stringify(s.events.map(e => e.event))}`)
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50) })
    }
  }
  return s
}

/** 要自定义 Host 头时用（fetch 不让改）。 */
export const raw = (url: string, o: { method?: string; headers?: Record<string, string>; body?: string; chunks?: string[] }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method ?? 'GET', headers: o.headers }, res => {
      let body = ''; res.on('data', c => (body += c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    })
    req.on('error', reject)
    if (o.chunks) { for (const c of o.chunks) req.write(c); req.end() } else req.end(o.body)
  })

export const types = (s: Sse) => s.events.map(e => e.event)
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
