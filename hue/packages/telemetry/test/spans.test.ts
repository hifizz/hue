import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HueEvent } from '@hue/core'
import { spanBuilder } from '../src/index.js'
import type { BuilderOptions, Span } from '../src/index.js'
import { byName, ev, usage } from './helpers.js'

const build = (events: HueEvent[], o: BuilderOptions = {}, closeAt?: number): Span[] => {
  const b = spanBuilder(o); const out = events.flatMap(e => b.push(e)); return closeAt === undefined ? out : [...out, ...b.close(closeAt)]
}

const simple = [
  ev.created({ at: 0 }), ev.turn({ at: 1000 }), ev.step({ at: 1010, est: 1234 }),
  ev.model({ at: 1500, ms: 400, u: usage(100, 20, 300, 50), finish: 'tool-calls', step: 1 }),
  ev.call('c1', { at: 1500, name: 'read', step: 1 }), ev.policy('c1', 'allow', { at: 1501 }), ev.result('c1', { at: 1600, name: 'read', text: 'file contents' }),
  ev.step({ at: 1610, step: 2 }), ev.model({ at: 2000, ms: 300, u: usage(10, 5), step: 2 }), ev.end('stop', { at: 2001, u: usage(110, 25, 300, 50), steps: 2 }),
]

test('一次 turn:invoke_agent、两个 chat、一个 execute_tool;层级和时间对', () => {
  const spans = build(simple)
  assert.deepEqual(spans.map(s => s.name), ['chat claude-x', 'execute_tool read', 'chat claude-x', 'invoke_agent'])
  const [chat1, tool, , turn] = spans as [Span, Span, Span, Span]
  assert.equal(new Set(spans.map(s => s.traceId)).size, 1); assert.match(turn.traceId, /^[0-9a-f]{32}$/); assert.match(turn.spanId, /^[0-9a-f]{16}$/)
  assert.equal(turn.parentSpanId, undefined)
  for (const s of [chat1, tool]) assert.equal(s.parentSpanId, turn.spanId)
  assert.deepEqual([turn.startMs, turn.endMs], [1000, 2001]); assert.deepEqual([chat1.startMs, chat1.endMs], [1100, 1500]); assert.deepEqual([tool.startMs, tool.endMs], [1500, 1600])
  assert.equal(new Set(spans.map(s => s.spanId)).size, 4)
  assert.deepEqual([turn.kind, chat1.kind, tool.kind], ['client', 'client', 'internal'])
})

test('chat span 的属性按 GenAI 约定:operation / provider / model / finish_reasons;input_tokens 含缓存读写', () => {
  const chat = byName(build(simple), 'chat')[0]!
  assert.deepEqual(chat.attributes, {
    'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'anthropic', 'gen_ai.request.model': 'claude-x', 'gen_ai.response.model': 'claude-x', 'gen_ai.response.finish_reasons': ['tool-calls'],
    'gen_ai.usage.input_tokens': 450, 'gen_ai.usage.output_tokens': 20, 'gen_ai.usage.cache_read.input_tokens': 300, 'gen_ai.usage.cache_write.input_tokens': 50, 'hue.step': 1,
  })
  const plain = byName(build([ev.turn(), ev.model({ u: usage(7, 3) })]), 'chat')[0]!
  assert.equal(plain.attributes['gen_ai.usage.input_tokens'], 7); assert.ok(!('gen_ai.usage.cache_read.input_tokens' in plain.attributes), '为 0 的缓存字段不写')
})

test('没有 provider 前缀的模型 id:provider 记 unknown,模型名原样', () => {
  const chat = byName(build([ev.turn(), ev.model({ modelId: 'mock' })]), 'chat')[0]!
  assert.deepEqual([chat.name, chat.attributes['gen_ai.provider.name'], chat.attributes['gen_ai.request.model']], ['chat mock', 'unknown', 'mock'])
})

test('invoke_agent span:会话 id、总用量(含缓存)、结束原因、步数、估算输入 token', () => {
  const turn = byName(build(simple), 'invoke_agent')[0]!
  assert.deepEqual(turn.attributes, {
    'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 's', 'hue.estimated_input_tokens': 1234, 'gen_ai.usage.input_tokens': 460, 'gen_ai.usage.output_tokens': 25,
    'gen_ai.usage.cache_read.input_tokens': 300, 'gen_ai.usage.cache_write.input_tokens': 50, 'hue.turn.end_reason': 'stop', 'hue.turn.steps': 2, 'gen_ai.request.model': 'claude-x',
  })
  assert.equal(turn.error, undefined)
})

test('execute_tool span:工具名 / 调用 id / effects / policy 决定;出错时 error.type 是错误码,状态为错误', () => {
  const ok = byName(build(simple), 'execute_tool')[0]!
  assert.deepEqual(ok.attributes, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'read', 'gen_ai.tool.call.id': 'c1', 'gen_ai.tool.type': 'function', 'hue.tool.effects': 'unsafe', 'hue.step': 1, 'hue.policy.action': 'allow' })
  const bad = byName(build([ev.turn(), ev.call('x'), ev.result('x', { error: { code: 'tool_error', message: 'boom' } }), ev.end('stop')]), 'execute_tool')[0]!
  assert.deepEqual(bad.error, { type: 'tool_error', message: 'boom' }); assert.equal(bad.attributes['error.type'], 'tool_error')
  const denied = byName(build([ev.turn(), ev.call('d'), ev.policy('d', 'deny'), ev.result('d', { error: { code: 'policy_denied', message: 'no' }, synthetic: 'denied' }), ev.end('stop')]), 'execute_tool')[0]!
  assert.deepEqual([denied.error?.type, denied.attributes['hue.tool.synthetic'], denied.attributes['hue.policy.action']], ['policy_denied', 'denied', 'deny'])
})

test('等人批准的时间:span 事件 + hue.input.wait_ms,按 requestId 对应到调用,并发的两个调用互不串', () => {
  const spans = build([ev.turn({ at: 0 }), ev.call('a', { at: 10 }), ev.call('b', { at: 11, name: 'edit' }), ev.ask('r1', 'a', { at: 20 }), ev.ask('r2', 'b', { at: 22 }), ev.answer('r2', { at: 30 }), ev.answer('r1', { at: 520 }),
    ev.result('b', { at: 31, name: 'edit' }), ev.result('a', { at: 530 }), ev.end('stop', { at: 540 })])
  const a = spans.find(s => s.attributes['gen_ai.tool.call.id'] === 'a')!, b = spans.find(s => s.attributes['gen_ai.tool.call.id'] === 'b')!
  assert.equal(a.attributes['hue.input.wait_ms'], 500); assert.equal(b.attributes['hue.input.wait_ms'], 8)
  assert.deepEqual(a.events.map(e => [e.name, e.atMs]), [['hue.input.requested', 20], ['hue.input.resolved', 520]])
  assert.equal(a.events[0]!.attributes['hue.input.kind'], 'approval'); assert.equal(a.events[1]!.attributes['hue.input.action'], 'accept')
})

test('turn 出错:error.type 是错误码;被打断不算错误,只记 end_reason', () => {
  const e = byName(build([ev.turn(), ev.end('error', { error: { code: 'context_overflow', message: 'too long' } })]), 'invoke_agent')[0]!
  assert.deepEqual(e.error, { type: 'context_overflow', message: 'too long' })
  const i = byName(build([ev.turn(), ev.end('interrupted')]), 'invoke_agent')[0]!
  assert.equal(i.error, undefined); assert.equal(i.attributes['hue.turn.end_reason'], 'interrupted')
  const noCode = byName(build([ev.turn(), ev.end('error')]), 'invoke_agent')[0]!; assert.equal(noCode.error?.type, 'error')
})

test('被打断的半截回复(finishReason aborted)标为错误;上下文压缩记成 turn 上的 span 事件', () => {
  const spans = build([ev.turn({ at: 0 }), ev.compacted({ at: 5 }), ev.model({ finish: 'aborted', at: 50 }), ev.end('interrupted', { at: 60 })])
  assert.equal(byName(spans, 'chat')[0]!.error?.type, 'aborted'); assert.deepEqual(byName(spans, 'chat')[0]!.attributes['gen_ai.response.finish_reasons'], ['interrupted'])
  assert.deepEqual(byName(spans, 'invoke_agent')[0]!.events, [{ name: 'hue.context.compacted', atMs: 5, attributes: { 'hue.compaction.strategy': 'fold-tool-results', 'hue.compaction.tokens_before': 900, 'hue.compaction.tokens_after': 300 } }])
})

test('内容默认不记;captureContent 才记工具参数和结果(截到 4096 字符;出错的调用不记结果)', () => {
  const evs = [ev.turn(), ev.call('c', { input: { command: 'cat .env' } }), ev.result('c', { text: 'x'.repeat(10_000) }), ev.call('d'), ev.result('d', { error: { code: 'tool_error', message: 'm' }, text: 'secret trace' }), ev.end('stop')]
  for (const s of byName(build(evs), 'execute_tool')) assert.ok(!Object.keys(s.attributes).some(k => k.startsWith('gen_ai.tool.call.arguments') || k === 'gen_ai.tool.call.result'))
  const [c, d] = byName(build(evs, { captureContent: true }), 'execute_tool') as [Span, Span]
  assert.equal(c.attributes['gen_ai.tool.call.arguments'], '{"command":"cat .env"}'); assert.equal((c.attributes['gen_ai.tool.call.result'] as string).length, 4096)
  assert.ok(!('gen_ai.tool.call.result' in d.attributes))
})

test('子 agent:子会话的 turn 挂在父会话那次 execute_tool 下面,同一条 trace;父 turn 另起的新 turn 是另一条 trace', () => {
  const spans = build([
    ev.created({ sessionId: 'P', at: 0 }), ev.turn({ sessionId: 'P', turnId: 'tp', at: 1 }), ev.model({ sessionId: 'P', turnId: 'tp', at: 5, finish: 'tool-calls' }), ev.call('k1', { sessionId: 'P', turnId: 'tp', at: 6, name: 'task' }),
    ev.created({ sessionId: 'C', turnId: 'none', at: 7, parent: { sessionId: 'P', turnId: 'tp', callId: 'k1' } }),
    ev.turn({ sessionId: 'C', turnId: 'tc', at: 8 }), ev.model({ sessionId: 'C', turnId: 'tc', at: 20 }), ev.call('g1', { sessionId: 'C', turnId: 'tc', at: 21 }), ev.result('g1', { sessionId: 'C', turnId: 'tc', at: 25 }), ev.end('stop', { sessionId: 'C', turnId: 'tc', at: 30 }),
    ev.result('k1', { sessionId: 'P', turnId: 'tp', at: 31, name: 'task' }), ev.end('stop', { sessionId: 'P', turnId: 'tp', at: 32 }),
    ev.turn({ sessionId: 'P', turnId: 'tp2', at: 100 }), ev.end('stop', { sessionId: 'P', turnId: 'tp2', at: 101 }),
  ])
  const parentTool = spans.find(s => s.attributes['gen_ai.tool.call.id'] === 'k1')!
  const childTurn = spans.find(s => s.attributes['gen_ai.conversation.id'] === 'C')!
  assert.equal(childTurn.parentSpanId, parentTool.spanId); assert.equal(childTurn.traceId, parentTool.traceId)
  const childTool = spans.find(s => s.attributes['gen_ai.tool.call.id'] === 'g1')!; assert.equal(childTool.traceId, parentTool.traceId); assert.equal(childTool.parentSpanId, childTurn.spanId)
  const parentTurns = spans.filter(s => s.name === 'invoke_agent' && s.attributes['gen_ai.conversation.id'] === 'P')
  assert.equal(parentTurns.length, 2); assert.notEqual(parentTurns[0]!.traceId, parentTurns[1]!.traceId)
  assert.equal(new Set(spans.map(s => s.spanId)).size, spans.length)
})

test('只导出子会话(没见过父会话的事件)也对得上:父的 trace / span id 是从事件里的 id 算出来的', () => {
  const full = build([ev.turn({ sessionId: 'P', turnId: 'tp' }), ev.call('k1', { sessionId: 'P', turnId: 'tp' }), ev.result('k1', { sessionId: 'P', turnId: 'tp' }), ev.end('stop', { sessionId: 'P', turnId: 'tp' })])
  const alone = build([ev.created({ sessionId: 'C', parent: { sessionId: 'P', turnId: 'tp', callId: 'k1' } }), ev.turn({ sessionId: 'C', turnId: 'tc' }), ev.end('stop', { sessionId: 'C', turnId: 'tc' })])
  const tool = full.find(s => s.name === 'execute_tool bash')!
  assert.equal(alone[0]!.parentSpanId, tool.spanId); assert.equal(alone[0]!.traceId, tool.traceId)
})

test('同一份事件导出两次,得到完全一样的 span(ID 由事件决定)', () => { assert.deepEqual(build(simple), build(simple)) })

test('日志中途断了:close 把没结束的 turn 和工具调用收尾,标 unfinished;已结束的不重复', () => {
  const spans = build([ev.turn({ at: 0 }), ev.call('c', { at: 10 }), ev.model({ at: 12 })], {}, 99)
  assert.deepEqual(spans.map(s => s.name), ['chat claude-x', 'execute_tool bash', 'invoke_agent'])
  for (const s of spans.slice(1)) { assert.equal(s.endMs, 99); assert.equal(s.error?.type, 'unfinished') }
  const b = spanBuilder(); simple.forEach(e => b.push(e)); assert.deepEqual(b.close(1), [])
})

test('turn 结束时还没出结果的工具调用:随 turn 收尾,标 unfinished', () => {
  const spans = build([ev.turn({ at: 0 }), ev.call('lost', { at: 5 }), ev.end('error', { at: 9, error: { code: 'model_error', message: 'x' } })])
  const tool = byName(spans, 'execute_tool')[0]!; assert.deepEqual([tool.endMs, tool.error?.type], [9, 'unfinished'])
})

test('崩溃恢复补出来的结果(没见过 tool.call):给一个 span 让它在 trace 里可见', () => {
  const [s] = build([ev.result('dead', { at: 500, ms: 0, error: { code: 'crashed', message: 'process crashed' }, synthetic: 'crashed' })]) as [Span]
  assert.deepEqual([s.name, s.error?.type, s.attributes['hue.tool.synthetic'], s.endMs - s.startMs], ['execute_tool bash', 'crashed', 'crashed', 0])
})

test('瞬时事件和不相关的事件被忽略;span 可以 JSON 序列化', () => {
  const b = spanBuilder(); const delta = { ...ev.turn(), type: 'model.delta', kind: 'text', delta: 'x' } as unknown as HueEvent
  assert.deepEqual([delta, ev.created()].flatMap(e => b.push(e)), [])
  JSON.stringify(build(simple))
})
