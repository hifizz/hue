import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fold } from '@hue/core'
import type { EventStore, HueEvent, Message, ModelChunk, ModelPort, Tool } from '@hue/core'
import { createAgent, drain, subagentTool } from '../src/index.js'

function memStore(): EventStore & { events: HueEvent[] } {
  const events: HueEvent[] = []
  return {
    specVersion: 'hue.store.v1', events,
    async append(es) { events.push(...structuredClone(es)) },
    async *read(sessionId) { for (const e of events) if (e.sessionId === sessionId) yield structuredClone(e) },
    async lastSeq(sessionId) { return events.filter(e => e.sessionId === sessionId).length },
  }
}
const fin = (r: 'stop' | 'tool-calls' = 'stop'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 10, outputTokens: 5 } })
const call = (callId: string, name: string, input: object): ModelChunk => ({ type: 'tool-call', callId, name, input: input as never })
const info = { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } }
const lastUser = (m: Message[]) => { const u = m.filter(x => x.role === 'user').at(-1); return u?.role === 'user' ? u.content.map(p => (p.type === 'text' ? p.text : '')).join('') : '' }

/** 父模型：第一步按脚本派活，第二步把所有子结果拼起来回答。 */
function parentModel(tasks: string[]): ModelPort & { requests: Message[][] } {
  const requests: Message[][] = []
  return {
    specVersion: 'hue.model.v1', id: 'parent', info, requests,
    async *stream(req) {
      requests.push(structuredClone(req.messages))
      if (req.messages.at(-1)!.role === 'user') { for (const [i, task] of tasks.entries()) yield call(`t${i}`, 'task', { task }); yield fin('tool-calls'); return }
      const results = req.messages.at(-1)!.role === 'tool' ? JSON.stringify(req.messages.at(-1)) : ''
      yield { type: 'text-delta', text: `汇总：${[...results.matchAll(/answer\(([^)]*)\)/g)].map(m => m[1]).join(',')}` }; yield fin()
    },
  }
}
/** 子模型：睡一会儿，回答 `answer(任务)`，并记录同时有几个在跑。 */
function childModel(stats: { running: number; max: number; requests: Message[][] }, ms = 30, fail = false): ModelPort {
  return {
    specVersion: 'hue.model.v1', id: 'child', info,
    async *stream(req, signal) {
      stats.requests.push(structuredClone(req.messages))
      stats.max = Math.max(stats.max, ++stats.running)
      try {
        await new Promise((r, j) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })) }) })
        if (fail) { yield { type: 'error', error: { code: 'model_error', message: 'boom' } }; return }
        yield { type: 'text-delta', text: `answer(${lastUser(req.messages)})` }; yield fin()
      } finally { stats.running-- }
    },
  }
}
const setup = (o: { tasks: string[]; effects?: Tool['effects']; maxConcurrent?: number; ms?: number; fail?: boolean }) => {
  const store = memStore(), stats = { running: 0, max: 0, requests: [] as Message[][] }
  const child = createAgent({ model: childModel(stats, o.ms, o.fail), store })
  const model = parentModel(o.tasks)
  const parent = createAgent({ model, store, tools: [subagentTool({ agent: child, effects: o.effects, maxConcurrent: o.maxConcurrent })] })
  return { store, stats, model, parent }
}

test('只读子 agent（effects: none）在同一步里并发跑，结果各自回到父 agent', async () => {
  const { store, stats, parent, model } = setup({ tasks: ['甲', '乙'], effects: 'none' })
  const r = await drain(parent.run('分头查', { sessionId: 'P' }))
  assert.equal(r.reason, 'stop'); assert.equal(stats.max, 2, '两个子 agent 同时在跑')
  const final = r.state.transcript.at(-1)!
  assert.match(JSON.stringify(final), /汇总：甲,乙/)
  // 事件树：每个子会话的 session.created 指回父会话里派它的那次调用
  const created = store.events.filter(e => e.type === 'session.created' && e.parent)
  assert.equal(created.length, 2)
  for (const c of created) {
    assert.ok(c.type === 'session.created' && c.parent!.sessionId === 'P' && ['t0', 't1'].includes(c.parent!.callId))
    const child = fold(c.sessionId, store.events.filter(e => e.sessionId === c.sessionId))
    assert.equal(child.openTurnId, undefined); assert.equal(child.transcript.length, 2)
  }
  // 父的 tool.result.data 里有子会话 id
  const results = store.events.filter(e => e.type === 'tool.result' && e.sessionId === 'P')
  assert.deepEqual(results.map(e => e.type === 'tool.result' && (e.data as { sessionId: string }).sessionId).sort(), created.map(c => c.sessionId).sort())
  assert.equal(model.requests.length, 2)
})

test('子 agent 的上下文是隔离的：只看得到任务，看不到父会话的历史，父也看不到子的中间过程', async () => {
  const { stats, parent, model } = setup({ tasks: ['只做这个'], effects: 'none' })
  await drain(parent.run('一大堆背景和另一个秘密任务', { sessionId: 'P' }))
  assert.deepEqual(stats.requests[0]!.map(m => m.role), ['user'])
  assert.equal(lastUser(stats.requests[0]!), '只做这个')
  assert.equal(JSON.stringify(model.requests[1]).includes('step.started'), false)
})

test('默认 effects 是 unsafe：串行，一次只跑一个', async () => {
  const { stats, parent } = setup({ tasks: ['甲', '乙', '丙'] })
  await drain(parent.run('x', { sessionId: 'P' }))
  assert.equal(stats.max, 1)
})

test('maxConcurrent 限制并发，多出来的排队，全部完成', async () => {
  const { stats, parent } = setup({ tasks: ['1', '2', '3', '4'], effects: 'none', maxConcurrent: 2 })
  const r = await drain(parent.run('x', { sessionId: 'P' }))
  assert.equal(stats.max, 2); assert.match(JSON.stringify(r.state.transcript.at(-1)), /汇总：1,2,3,4/)
})

test('子 agent 失败：父拿到 isError 的结果，自己照常继续', async () => {
  const { parent, store } = setup({ tasks: ['会失败的'], effects: 'none', fail: true })
  const r = await drain(parent.run('x', { sessionId: 'P' }))
  assert.equal(r.reason, 'stop')
  const res = store.events.find(e => e.type === 'tool.result' && e.sessionId === 'P')!
  assert.ok(res.type === 'tool.result' && res.isError && JSON.stringify(res.content).includes('boom'))
})

test('打断父 agent：子 agent 一起被打断，不留悬空的 turn', async () => {
  const { parent, store, stats } = setup({ tasks: ['甲', '乙'], effects: 'none', ms: 5000 })
  const r = await drain(parent.run('x', { sessionId: 'P' }), e => { if (e.type === 'tool.call') setTimeout(() => parent.interrupt('P'), 20) })
  assert.equal(r.reason, 'interrupted'); assert.equal(stats.running, 0)
  for (const c of store.events.filter(e => e.type === 'session.created' && e.parent)) {
    const child = fold(c.sessionId, store.events.filter(e => e.sessionId === c.sessionId))
    assert.equal(child.openTurnId, undefined)
    assert.ok(store.events.some(e => e.sessionId === c.sessionId && e.type === 'turn.ended' && e.reason === 'interrupted'))
  }
  assert.equal(fold('P', store.events).danglingCalls.length, 0)
})

test('排队中的子 agent 也能被打断（不会一直占着位置）', async () => {
  const { parent, stats } = setup({ tasks: ['1', '2', '3'], effects: 'none', maxConcurrent: 1, ms: 5000 })
  const r = await drain(parent.run('x', { sessionId: 'P' }), e => { if (e.type === 'tool.call' && e.callId === 't2') setTimeout(() => parent.interrupt('P'), 20) })
  assert.equal(r.reason, 'interrupted'); assert.equal(stats.max, 1)
})

test('参数不合法：parse 抛错（loop 会把错误回给模型让它重试）', async () => {
  const stats = { running: 0, max: 0, requests: [] as Message[][] }
  const tool = subagentTool({ agent: createAgent({ model: childModel(stats), store: memStore() }) })
  assert.throws(() => tool.parse!({ task: '  ' }), /non-empty/); assert.throws(() => tool.parse!({}), /non-empty/)
  assert.equal(tool.parse!({ task: 'ok' }).task, 'ok')
})
