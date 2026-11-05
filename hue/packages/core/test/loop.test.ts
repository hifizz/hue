import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTurn, fold, emptyState, userText, isDurable, repairDangling, textResult } from '../src/index.js'
import type { ModelPort, ModelChunk, HueEvent, Tool, TurnResult, PolicyPort } from '../src/index.js'

/** 脚本化 mock 模型：每次 stream 消费一段脚本。 */
function scripted(steps: ModelChunk[][], opts: { delayMs?: number } = {}): ModelPort & { requests: unknown[] } {
  let i = 0; const requests: unknown[] = []
  return {
    specVersion: 'hue.model.v1', id: 'mock:1', requests,
    info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(req, signal) {
      requests.push(structuredClone(req))
      for (const c of steps[i++] ?? []) {
        if (opts.delayMs) await new Promise((r, j) => { const t = setTimeout(r, opts.delayMs); signal.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })) }) })
        yield c
      }
    },
  }
}
const fin = (r: 'stop' | 'tool-calls' = 'stop'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 10, outputTokens: 5 } })
const call = (id: string, name: string, input: object = {}): ModelChunk => ({ type: 'tool-call', callId: id, name, input: input as never })

async function drain(g: AsyncGenerator<HueEvent, TurnResult>, onEvent?: (e: HueEvent) => void) {
  const events: HueEvent[] = []
  while (true) { const r = await g.next(); if (r.done) return { events, result: r.value }; events.push(r.value); onEvent?.(r.value) }
}
let n = 0; const ids = () => `id${++n}`
const base = (model: ModelPort, extra: object = {}) => ({ sessionId: 's1', state: emptyState('s1'), input: userText('hi'), model, newId: ids, now: () => 0, ...extra })

const sleepTool = (name: string, effects: Tool['effects'], ms: number, log: string[]): Tool => ({
  name, description: name, inputSchema: { type: 'object' }, effects,
  async execute(_i, ctx) { log.push(`start:${name}:${ctx.callId}`); await new Promise(r => setTimeout(r, ms)); log.push(`end:${name}:${ctx.callId}`); return textResult('ok') },
})

test('plain answer: stop, state == fold(durable events)', async () => {
  const { events, result } = await drain(runTurn(base(scripted([[{ type: 'text-delta', text: 'hel' }, { type: 'text-delta', text: 'lo' }, fin()]]))))
  assert.equal(result.reason, 'stop')
  assert.deepEqual(events.map(e => e.type), ['turn.started', 'user.message', 'step.started', 'model.delta', 'model.delta', 'model.message', 'turn.ended'])
  const durable = events.filter(isDurable)
  assert.deepEqual(durable.map(e => e.seq), [1, 2, 3, 4, 5])
  assert.deepEqual(fold('s1', durable), result.state)
})

test('tool loop: call/result paired, second request sees result', async () => {
  const log: string[] = []
  const m = scripted([[call('c1', 'a'), fin('tool-calls')], [{ type: 'text-delta', text: 'done' }, fin()]])
  const { result } = await drain(runTurn(base(m, { tools: [sleepTool('a', 'unsafe', 1, log)] })))
  assert.equal(result.reason, 'stop'); assert.equal(result.steps, 2)
  const msgs = (m.requests[1] as { messages: { role: string }[] }).messages.map(x => x.role)
  assert.deepEqual(msgs, ['user', 'assistant', 'tool'])
})

test('scheduling: consecutive read-only calls run in parallel, unsafe serial, results ordered for model', async () => {
  const log: string[] = []
  const m = scripted([[call('r1', 'read'), call('r2', 'read'), call('w1', 'write'), fin('tool-calls')], [fin()]])
  const tools = [sleepTool('read', 'none', 20, log), sleepTool('write', 'unsafe', 1, log)]
  await drain(runTurn(base(m, { tools })))
  assert.deepEqual(log.slice(0, 2), ['start:read:r1', 'start:read:r2'])
  assert.ok(log.indexOf('start:write:w1') > log.indexOf('end:read:r2'))
  const toolMsg = (m.requests[1] as any).messages[2]
  assert.deepEqual(toolMsg.content.map((p: any) => p.callId), ['r1', 'r2', 'w1'])
})

test('write-ahead: tool.call is yielded before execute starts', async () => {
  const log: string[] = []
  const m = scripted([[call('c1', 'a'), fin('tool-calls')], [fin()]])
  await drain(runTurn(base(m, { tools: [sleepTool('a', 'unsafe', 1, log)] })), e => { if (e.type === 'tool.call') log.push('persisted:c1') })
  assert.deepEqual(log.slice(0, 2), ['persisted:c1', 'start:a:c1'])
})

test('unknown tool and invalid input go back to the model as errors', async () => {
  const strict: Tool = { name: 'strict', description: '', inputSchema: {}, effects: 'none', parse: () => { throw new Error('x required') }, execute: async () => textResult('never') }
  const m = scripted([[call('c1', 'nope'), call('c2', 'strict'), fin('tool-calls')], [fin()]])
  const { events } = await drain(runTurn(base(m, { tools: [strict] })))
  const res = events.filter(e => e.type === 'tool.result') as any[]
  assert.deepEqual(res.map(r => r.error.code).sort(), ['invalid_tool_input', 'tool_not_found'])
})

test('policy deny / ask via InputPort', async () => {
  const log: string[] = []
  const policy: PolicyPort = { specVersion: 'hue.policy.v1', decide: async c => c.tool === 'a' ? { action: 'deny', reason: 'no' } : { action: 'ask', prompt: 'ok?' } }
  const m = scripted([[call('c1', 'a'), call('c2', 'b'), fin('tool-calls')], [fin()]])
  const { events } = await drain(runTurn(base(m, { policy, tools: [sleepTool('a', 'unsafe', 1, log), sleepTool('b', 'unsafe', 1, log)], inputPort: { request: async () => ({ action: 'accept' }) } })))
  const res = events.filter(e => e.type === 'tool.result') as any[]
  assert.equal(res[0].synthetic, 'denied'); assert.equal(res[1].isError, false)
  assert.ok(events.some(e => e.type === 'input.resolved'))
})

test('interrupt mid-tool: every tool.call still gets exactly one tool.result', async () => {
  const log: string[] = []
  const ac = new AbortController()
  const slow: Tool = { name: 'slow', description: '', inputSchema: {}, effects: 'unsafe', execute: (_i, ctx) => new Promise((_, j) => ctx.signal.addEventListener('abort', () => j(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }
  const m = scripted([[call('c1', 'slow'), call('c2', 'slow'), fin('tool-calls')]])
  const { events, result } = await drain(runTurn(base(m, { tools: [slow], signal: ac.signal })), e => { if (e.type === 'tool.call') setTimeout(() => ac.abort(), 5) })
  assert.equal(result.reason, 'interrupted')
  const calls = events.filter(e => e.type === 'tool.call').map((e: any) => e.callId)
  const results = events.filter(e => e.type === 'tool.result').map((e: any) => [e.callId, e.synthetic])
  assert.deepEqual(calls, ['c1', 'c2'])
  assert.deepEqual(results, [['c1', 'interrupted'], ['c2', 'not_run']])
  assert.equal(result.state.danglingCalls.length, 0)
})

test('crash recovery: dangling call repaired as crashed', () => {
  const s = fold('s1', [
    { v: 1, id: 'a', sessionId: 's1', seq: 1, at: 0, type: 'turn.started', turnId: 't' },
    { v: 1, id: 'b', sessionId: 's1', seq: 2, at: 0, type: 'model.message', modelId: 'm', finishReason: 'tool-calls', usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0, message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'c1', name: 'bash', input: {} }] } },
    { v: 1, id: 'c', sessionId: 's1', seq: 3, at: 0, type: 'tool.call', callId: 'c1', name: 'bash', input: {}, effects: 'unsafe' },
  ] as HueEvent[])
  const fix = repairDangling(s)
  assert.equal(fix.length, 2)
  assert.equal((fix[0] as any).synthetic, 'crashed')
  assert.equal(fix[1].type, 'turn.ended')
})

test('steer: message pulled between steps keeps the turn going', async () => {
  let pulled = false
  const m = scripted([[{ type: 'text-delta', text: 'a' }, fin()], [{ type: 'text-delta', text: 'b' }, fin()]])
  const { result } = await drain(runTurn(base(m, { pullSteer: () => pulled ? [] : (pulled = true, [userText('also this')]) })))
  assert.equal(result.steps, 2)
  assert.deepEqual(result.state.transcript.map(x => x.role), ['user', 'assistant', 'user', 'assistant'])
})

test('duplicate tool names fail the turn up front', async () => {
  const t = sleepTool('a', 'none', 1, [])
  const { result } = await drain(runTurn(base(scripted([[fin()]]), { tools: [t, t] })))
  assert.equal(result.reason, 'error')
})

test('maxSteps stops a runaway loop', async () => {
  const m = scripted(Array.from({ length: 10 }, (_, i) => [call(`c${i}`, 'a'), fin('tool-calls')]))
  const { result } = await drain(runTurn(base(m, { maxSteps: 3, tools: [sleepTool('a', 'none', 1, [])] })))
  assert.equal(result.reason, 'stop_condition'); assert.equal(result.steps, 3)
})
