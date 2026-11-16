import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkTrace, formatTraceReport, parseTrace, type TraceLine } from './check-trace.js'

const req = (messages: object[], extra: object = {}): TraceLine => ({ at: 1, type: 'request', body: { messages, ...extra } as never })
const th = (thinking: string, signature?: string) => ({ type: 'thinking', thinking, ...(signature !== undefined && { signature }) })
const use = (id: string) => ({ type: 'tool_use', id, name: 'bash', input: {} })
const res = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'x' })
const bp = { cache_control: { type: 'ephemeral' } }

test('thinking：带签名的往返算通过；缺签名、同签名文本被改都要报出来', () => {
  const ok = checkTrace([
    req([{ role: 'user', content: 'hi' }]),
    req([{ role: 'user', content: 'hi' }, { role: 'assistant', content: [th('plan', 'SIG1'), use('a')] }, { role: 'user', content: [res('a')] }]),
    req([{ role: 'user', content: 'hi' }, { role: 'assistant', content: [th('plan', 'SIG1'), use('a')] }, { role: 'user', content: [res('a')] }]),
  ])
  assert.equal(ok.thinking.signedBlocks, 2); assert.equal(ok.thinking.unsignedBlocks, 0); assert.equal(ok.thinking.changedBetweenRequests, 0)
  assert.match(formatTraceReport(ok), /签名原样往返：通过/)

  const bad = checkTrace([
    req([{ role: 'assistant', content: [th('plan', 'SIG1')] }]),
    req([{ role: 'assistant', content: [th('plan EDITED', 'SIG1')] }]),
    req([{ role: 'assistant', content: [th('no sig')] }]),
  ])
  assert.equal(bad.thinking.changedBetweenRequests, 1); assert.equal(bad.thinking.unsignedBlocks, 1)
  assert.match(formatTraceReport(bad), /有问题/)
})

test('没有任何历史 thinking 块时明说"不能算通过"，不假装通过', () => {
  const r = checkTrace([req([{ role: 'user', content: 'hi' }])])
  assert.equal(r.thinking.requestsWithThinkingBlocks, 0)
  assert.match(formatTraceReport(r), /不能算通过/)
})

test('redacted_thinking 单独计数，不算缺签名', () => {
  const r = checkTrace([req([{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'xx' }] }])])
  assert.equal(r.thinking.redacted, 1); assert.equal(r.thinking.unsignedBlocks, 0)
})

test('缓存断点：system / tools / 最后一条消息分别计数，超过 4 个报出来', () => {
  const r = checkTrace([
    req([{ role: 'user', content: [{ type: 'text', text: 'a', ...bp }] }], { system: [{ type: 'text', text: 's', ...bp }], tools: [{ type: 'function', name: 't', ...bp }] }),
    req([{ role: 'user', content: [{ type: 'text', text: 'a', ...bp }, { type: 'text', text: 'b', ...bp }, { type: 'text', text: 'c', ...bp }, { type: 'text', text: 'd', ...bp }, { type: 'text', text: 'e', ...bp }] }]),
  ])
  assert.deepEqual([r.cache.systemBreakpoint, r.cache.toolsBreakpoint, r.cache.lastMessageBreakpoint], [1, 1, 2])
  assert.equal(r.cache.breakpointsMax, 5); assert.equal(r.cache.overFour, 1)
})

test('配对：孤立的 tool_use 和孤立的 tool_result 都能发现', () => {
  const r = checkTrace([req([
    { role: 'assistant', content: [use('a'), use('b')] }, { role: 'user', content: [res('a'), res('z')] },
  ])])
  assert.equal(r.pairing.orphanToolUse, 1); assert.equal(r.pairing.orphanToolResult, 1)
})

test('请求体增长按请求顺序记录；响应状态码与相关头被汇总', () => {
  const r = checkTrace([
    req([{ role: 'user', content: 'a' }]),
    { at: 2, type: 'response', status: 200, headers: { 'x-request-id': 'r1', 'content-type': 'text/event-stream', 'cf-cache-status': 'DYNAMIC' } },
    req([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]),
  ])
  assert.deepEqual(r.growth.map(g => g.messages), [1, 2]); assert.ok(r.growth[1]!.approxChars > r.growth[0]!.approxChars)
  assert.deepEqual(r.responses[0]!.cacheHeaders, { 'x-request-id': 'r1', 'cf-cache-status': 'DYNAMIC' })
})

test('请求体是 JSON 字符串（真实 trace 的格式）也能解析，结果和对象一样；坏 JSON 报出是第几个请求', () => {
  const messages = [{ role: 'assistant', content: [th('plan', 'SIG1'), use('a')] }, { role: 'user', content: [res('a')] }]
  const asObj = checkTrace([req(messages)]), asStr = checkTrace([{ at: 1, type: 'request', body: JSON.stringify({ messages }) }])
  assert.deepEqual(asStr, asObj); assert.equal(asStr.thinking.signedBlocks, 1)
  assert.throws(() => checkTrace([{ at: 1, type: 'request', body: '{oops' }]), /第 1 个请求/)
})

test('parseTrace：坏行报出行号；空行忽略', () => {
  assert.equal(parseTrace('\n{"type":"request"}\n\n').length, 1)
  assert.throws(() => parseTrace('{"type":"request"}\nnot json'), /第 2 行/)
})
