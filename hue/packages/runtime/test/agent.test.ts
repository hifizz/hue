import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fold, isDurable, textResult } from '@hue/core'
import type { EventStore, HueEvent, Message, ModelChunk, ModelPort, Tool } from '@hue/core'
import { createAgent, drain } from '../src/index.js'

// ═════════ 测试替身：内存日志、脚本化模型、几个工具 ═════════
function memStore(): EventStore & { events: HueEvent[]; failAfter?: number } {
  const events: HueEvent[] = []
  const s = {
    specVersion: 'hue.store.v1' as const, events, failAfter: undefined as number | undefined,
    async append(es: HueEvent[]) {
      if (s.failAfter !== undefined && events.length >= s.failAfter) throw new Error('disk full')
      events.push(...structuredClone(es))
    },
    async *read(sessionId: string) { for (const e of events) if (e.sessionId === sessionId) yield structuredClone(e) },
    async lastSeq(sessionId: string) { return events.filter(e => e.sessionId === sessionId).length },
  }
  return s
}

const fin = (r: 'stop' | 'tool-calls' = 'stop'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 10, outputTokens: 5 } })
const call = (callId: string, name: string, input: object = {}): ModelChunk => ({ type: 'tool-call', callId, name, input: input as never })
const text = (t: string): ModelChunk => ({ type: 'text-delta', text: t })

/** 每次 stream 消费一段脚本；steps 里可以放函数，用来在"模型正在输出"时做点事。 */
function scripted(steps: Array<ModelChunk[] | (() => ModelChunk[])>): ModelPort & { requests: Message[][] } {
  let i = 0; const requests: Message[][] = []
  return {
    specVersion: 'hue.model.v1', id: 'mock:1', requests,
    info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(req) {
      requests.push(structuredClone(req.messages))
      const s = steps[i++] ?? [text('(script exhausted)'), fin()]
      for (const c of typeof s === 'function' ? s() : s) yield c
    },
  }
}

const tool = (name: string, effects: Tool['effects'], run: Tool['execute']): Tool => ({ name, description: name, inputSchema: { type: 'object' }, effects, execute: run })
const quick = tool('quick', 'unsafe', async () => textResult('done'))
/** 一直等到被打断。信号可能在工具开始前就已经是 aborted（放弃 run 时），所以要先检查。 */
const hang = tool('hang', 'unsafe', (_i, ctx) => new Promise((_, rej) => {
  const stop = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  if (ctx.signal.aborted) stop(); else ctx.signal.addEventListener('abort', stop)
}))

const seqs = (es: HueEvent[]) => es.filter(isDurable).map(e => e.seq)

test('run：每个 durable 事件都落盘，日志 fold 回来等于 turn 的状态；新会话以 session.created 开头', async () => {
  const store = memStore()
  const agent = createAgent({ model: scripted([[call('c1', 'quick'), fin('tool-calls')], [text('好了'), fin()]]), store, tools: [quick] })
  const seen: HueEvent[] = []; const early: string[] = []
  const r = await drain(agent.run('干活', { sessionId: 's1' }), e => { seen.push(e); if (isDurable(e) && !store.events.some(x => x.id === e.id)) early.push(e.type) })
  assert.deepEqual(early, [], '调用方收到事件时它已经在盘上')
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 2); assert.equal(r.turns, 1); assert.deepEqual(r.undelivered, [])
  assert.equal(store.events[0]!.type, 'session.created')
  assert.deepEqual(store.events.map(e => e.seq), store.events.map((_, i) => i + 1))
  assert.deepEqual(store.events, seen.filter(isDurable), '调用方看到的 durable 事件 == 盘上的')
  assert.deepEqual(fold('s1', store.events), r.state)
})

test('写前日志：工具开始执行时，它自己的 tool.call 已经在盘上', async () => {
  const store = memStore(); let onDisk: boolean | undefined
  const probe = tool('probe', 'unsafe', async (_i, ctx) => { onDisk = store.events.some(e => e.type === 'tool.call' && e.callId === ctx.callId); return textResult('ok') })
  await drain(createAgent({ model: scripted([[call('p1', 'probe'), fin('tool-calls')], [fin()]]), store, tools: [probe] }).run('x', { sessionId: 's' }))
  assert.equal(onDisk, true)
})

test('不给 sessionId 就新建；给了就接着聊，模型看得到历史', async () => {
  const store = memStore(); const model = scripted([[text('一'), fin()], [text('二'), fin()]])
  const agent = createAgent({ model, store })
  const a = await drain(agent.run('第一句'))
  const b = await drain(agent.run('第二句', { sessionId: a.sessionId }))
  assert.equal(b.sessionId, a.sessionId)
  assert.deepEqual(model.requests[1]!.map(m => m.role), ['user', 'assistant', 'user'])
  assert.equal(store.events.filter(e => e.type === 'session.created').length, 1)
  assert.deepEqual(seqs(store.events), store.events.map((_, i) => i + 1))
})

test('恢复：上次死在工具执行中途 → 先补 crashed 结果并关掉那个 turn，再开始新 turn', async () => {
  const store = memStore(); const model = scripted([[text('看到了'), fin()]])
  const env = (seq: number) => ({ v: 1, id: `old${seq}`, sessionId: 's', seq, at: seq, turnId: 't0' })
  await store.append([
    { ...env(1), type: 'session.created' },
    { ...env(2), type: 'turn.started', turnId: 't0' },
    { ...env(3), type: 'user.message', message: { role: 'user', content: [{ type: 'text', text: '部署' }] } },
    { ...env(4), type: 'model.message', message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'dead', name: 'bash', input: {} }] }, modelId: 'm', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 },
    { ...env(5), type: 'tool.call', callId: 'dead', name: 'bash', input: {}, effects: 'unsafe' },
  ] as HueEvent[])
  const r = await drain(createAgent({ model, store }).run('继续', { sessionId: 's' }))
  assert.equal(r.reason, 'stop')
  assert.deepEqual(model.requests[0]!.map(m => m.role), ['user', 'assistant', 'tool', 'user'])
  assert.match(JSON.stringify(model.requests[0]![2]), /crashed/)
  assert.deepEqual(seqs(store.events), store.events.map((_, i) => i + 1))
  assert.equal(fold('s', store.events).openTurnId, undefined)
})

test('同一个会话不能同时跑两个 turn；不同会话互不影响；跑完后锁释放', async () => {
  const store = memStore(); let open!: () => void; const gate = new Promise<void>(r => { open = r })
  const slow = tool('slow', 'unsafe', async () => { await gate; return textResult('ok') })
  const agent = createAgent({ model: scripted([[call('c', 'slow'), fin('tool-calls')], [fin()], [fin()], [fin()]]), store, tools: [slow] })
  const first = drain(agent.run('a', { sessionId: 'A' }))
  await new Promise(r => setTimeout(r, 20))
  await assert.rejects(drain(agent.run('b', { sessionId: 'A' })), /already has a running turn/)
  await drain(agent.run('c', { sessionId: 'B' })) // 另一个会话照常
  open(); await first
  assert.equal((await drain(agent.run('d', { sessionId: 'A' }))).reason, 'stop')
})

test('steer：工具执行期间插话，在这一步结果齐了之后送给模型，日志里标 steer', async () => {
  const store = memStore(); let agent: ReturnType<typeof createAgent>
  const work = tool('work', 'unsafe', async () => { assert.equal(agent.steer('s', '顺便把测试也跑一下'), true); return textResult('ok') })
  const model = scripted([[call('c', 'work'), fin('tool-calls')], [text('好'), fin()]])
  agent = createAgent({ model, store, tools: [work] })
  const r = await drain(agent.run('x', { sessionId: 's' }))
  assert.equal(r.reason, 'stop'); assert.equal(r.turns, 1)
  assert.deepEqual(model.requests[1]!.map(m => m.role), ['user', 'assistant', 'tool', 'user'])
  assert.match(JSON.stringify(model.requests[1]!.at(-1)), /顺便把测试也跑一下/)
  assert.ok(store.events.some(e => e.type === 'user.message' && e.steer === true))
})

test('steer：turn 结束的瞬间才到的插话不丢，接着开一个 turn', async () => {
  const store = memStore(); const model = scripted([[text('一'), fin()], [text('二'), fin()]])
  const agent = createAgent({ model, store })
  const r = await drain(agent.run('x', { sessionId: 's' }), e => { if (e.type === 'turn.ended' && e.usage.inputTokens > 0 && model.requests.length === 1) agent.steer('s', '还有一件事') })
  assert.equal(r.turns, 2); assert.equal(r.steps, 2); assert.equal(r.usage.inputTokens, 20); assert.equal(r.reason, 'stop')
  assert.match(JSON.stringify(model.requests[1]!.at(-1)), /还有一件事/)
  assert.equal(store.events.filter(e => e.type === 'turn.ended').length, 2)
})

test('steer / interrupt 对没在跑的会话返回 false', () => {
  const agent = createAgent({ model: scripted([]), store: memStore() })
  assert.equal(agent.steer('nope', 'x'), false); assert.equal(agent.interrupt('nope'), false)
})

test('interrupt：正在跑的工具被打断，日志里是 interrupted 结果；打断后才到的插话原样还给调用方', async () => {
  const store = memStore(); const agent = createAgent({ model: scripted([[call('c', 'hang'), fin('tool-calls')]]), store, tools: [hang] })
  const r = await drain(agent.run('x', { sessionId: 's' }), e => {
    if (e.type === 'tool.call') setTimeout(() => agent.interrupt('s'), 10)
    if (e.type === 'turn.ended') agent.steer('s', '算了')
  })
  assert.equal(r.reason, 'interrupted')
  assert.equal(r.undelivered.length, 1); assert.match(JSON.stringify(r.undelivered[0]), /算了/)
  const res = store.events.find(e => e.type === 'tool.result')!
  assert.ok(res.type === 'tool.result' && res.isError && res.error?.code === 'interrupted')
  assert.equal(fold('s', store.events).danglingCalls.length, 0)
  assert.equal((await drain(createAgent({ model: scripted([[fin()]]), store }).run('再来', { sessionId: 's' }))).reason, 'stop') // 会话可以继续
})

test('外部 signal 也能打断', async () => {
  const ac = new AbortController(); const store = memStore()
  const agent = createAgent({ model: scripted([[call('c', 'hang'), fin('tool-calls')]]), store, tools: [hang] })
  const r = await drain(agent.run('x', { sessionId: 's', signal: ac.signal }), e => { if (e.type === 'tool.call') setTimeout(() => ac.abort(), 10) })
  assert.equal(r.reason, 'interrupted')
})

test('调用方中途放弃（return）：先打断并补齐日志，不留悬空的 tool.call，会话随即可用', async () => {
  const store = memStore(); const agent = createAgent({ model: scripted([[call('c', 'hang'), fin('tool-calls')]]), store, tools: [hang] })
  const g = agent.run('x', { sessionId: 's' })
  for (let n = await g.next(); !n.done; n = await g.next()) if (n.value.type === 'tool.call') break
  await g.return(undefined as never)
  const state = fold('s', store.events)
  assert.equal(state.danglingCalls.length, 0); assert.equal(state.openTurnId, undefined)
  assert.equal(store.events.at(-1)!.type, 'turn.ended')
  assert.equal(agent.interrupt('s'), false) // 锁已释放
})

test('落盘失败：run 带着原错误失败，会话锁释放', async () => {
  const store = memStore(); store.failAfter = 3
  const agent = createAgent({ model: scripted([[text('x'), fin()]]), store })
  await assert.rejects(drain(agent.run('x', { sessionId: 's' })), /disk full/)
  assert.equal(agent.steer('s', 'x'), false)
})

test('子 agent 的 parent 写进 session.created', async () => {
  const store = memStore(); const parent = { sessionId: 'p', turnId: 't', callId: 'c' }
  await drain(createAgent({ model: scripted([[fin()]]), store }).run('x', { sessionId: 'child', parent, meta: { role: 'reviewer' } }))
  assert.deepEqual(store.events[0], { ...store.events[0]!, type: 'session.created', parent, meta: { role: 'reviewer' } })
})
