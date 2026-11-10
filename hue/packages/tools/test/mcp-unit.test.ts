import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adapt, checkHeaderAnnotations, effectsOf, paramHeaders, toOutput, toolLister } from '../src/mcp/index.js'
import { encodeHeaderValue } from '../src/mcp/client.js'
import { createClient } from '../src/mcp/client.js'
import type { Client, Result } from '../src/mcp/client.js'
import type { Reply, RpcMessage, Transport } from '../src/mcp/transport.js'
import { ctxOf, run, text } from './mcp-helpers.js'

test('encodeHeaderValue：按规范的表——纯 ASCII 原样，非 ASCII / 首尾空白 / 控制字符 / 长得像哨兵的值用 Base64 哨兵格式', () => {
  assert.equal(encodeHeaderValue('us-west1'), 'us-west1')
  assert.equal(encodeHeaderValue('a b'), 'a b')
  assert.equal(encodeHeaderValue('Hello, 世界'), '=?base64?SGVsbG8sIOS4lueVjA==?=')
  assert.equal(encodeHeaderValue(' padded '), '=?base64?IHBhZGRlZCA=?=')
  assert.equal(encodeHeaderValue('line1\nline2'), '=?base64?bGluZTEKbGluZTI=?=')
  assert.equal(encodeHeaderValue('=?base64?literal?='), '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')
  assert.equal(encodeHeaderValue(''), '=?base64??=', '空值也走编码（不能让头为空）')
})

test('checkHeaderAnnotations：合法的返回 undefined；非原始类型、number、不在 properties 链上、重复（不区分大小写）、名字不是 token 都拒绝', () => {
  const ok = { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' }, n: { type: 'object', properties: { b: { type: 'integer', 'x-mcp-header': 'B' } } }, c: { type: 'boolean', 'x-mcp-header': 'C' } } }
  assert.equal(checkHeaderAnnotations(ok), undefined); assert.equal(checkHeaderAnnotations({ type: 'object' }), undefined)
  const p = (prop: object) => checkHeaderAnnotations({ type: 'object', properties: { x: prop } })
  assert.match(p({ type: 'number', 'x-mcp-header': 'X' })!, /non-primitive or number/)
  assert.match(p({ type: 'object', 'x-mcp-header': 'X' })!, /non-primitive/)
  assert.match(p({ type: 'string', 'x-mcp-header': '' })!, /invalid/); assert.match(p({ type: 'string', 'x-mcp-header': 'Bad Name' })!, /invalid/); assert.match(p({ type: 'string', 'x-mcp-header': 'A\r\nB' })!, /invalid/)
  assert.match(p({ type: 'array', items: { type: 'string', 'x-mcp-header': 'I' } })!, /outside the properties chain/)
  assert.match(p({ oneOf: [{ type: 'string', 'x-mcp-header': 'I' }] })!, /outside/)
  assert.match(p({ $ref: '#/$defs/y' , $defs: { y: { type: 'string', 'x-mcp-header': 'Y' } } } as never)!, /outside/)
  assert.match(checkHeaderAnnotations({ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Same' }, b: { type: 'string', 'x-mcp-header': 'SAME' } } })!, /duplicate/)
})

test('paramHeaders：取到的值转字符串；null、缺省、未标注的不出现', () => {
  const schema = { type: 'object', properties: { r: { type: 'string', 'x-mcp-header': 'Region' }, n: { type: 'object', properties: { k: { type: 'integer', 'x-mcp-header': 'K' } } }, q: { type: 'string' }, z: { type: 'string', 'x-mcp-header': 'Z' } } }
  assert.deepEqual(paramHeaders(schema, { r: 'eu', n: { k: 7 }, q: 'secret', z: null }), { 'Mcp-Param-Region': 'eu', 'Mcp-Param-K': '7' })
  assert.deepEqual(paramHeaders(schema, {}), {})
})

test('effectsOf：readOnly → none，idempotent → idempotent，其余 → unsafe；覆盖表优先；不信任标注时全是 unsafe（覆盖表仍生效）', () => {
  const d = (annotations?: object) => ({ name: 't', inputSchema: {}, annotations }) as never
  assert.deepEqual([d({ readOnlyHint: true }), d({ idempotentHint: true }), d({ destructiveHint: true }), d(), d({ readOnlyHint: true, idempotentHint: true })].map(x => effectsOf(x, {})), ['none', 'idempotent', 'unsafe', 'unsafe', 'none'])
  assert.equal(effectsOf(d({ readOnlyHint: true }), { effects: { t: 'unsafe' } }), 'unsafe')
  assert.equal(effectsOf(d({ readOnlyHint: true }), { trustAnnotations: false }), 'unsafe'); assert.equal(effectsOf(d(), { trustAnnotations: false, effects: { t: 'none' } }), 'none')
})

test('toOutput：只有 structuredContent 时补一段文本，让模型看得到；任意 JSON 值都放得进 data', () => {
  const a = toOutput({ resultType: 'complete', structuredContent: [1, 2] })
  assert.deepEqual([a.content, a.data], [[{ type: 'text', text: '[1,2]' }], [1, 2]])
  assert.deepEqual(toOutput({ content: [{ type: 'text', text: 'x' }], structuredContent: null }).data, null)
  assert.equal(toOutput({ content: [{ type: 'weird' }] }).content[0]!.type, 'text')
})

// ───── toolLister ─────
const fakeClient = (pages: Array<Record<string, unknown>>, calls: unknown[] = []): Client => ({
  connect: async () => undefined, protocol: () => undefined, close: async () => {},
  rpc: async (_m, params) => { calls.push(params); const i = params.cursor ? Number(params.cursor) : 0; return { resultType: 'complete', ...pages[i]! } as Result },
})

test('toolLister：按 ttlMs 缓存，过期再取；多页合并且保持顺序；ttl 取各页最小的；没给 ttl 用默认值；并发请求共用一次', async () => {
  let now = 1000; const calls: unknown[] = []
  const l = toolLister(fakeClient([{ tools: [{ name: 'b' }, { name: 'a' }], nextCursor: '1', ttlMs: 500 }, { tools: [{ name: 'c' }], ttlMs: 300 }], calls), 9999, () => now)
  const sig = new AbortController().signal
  const [x, y] = await Promise.all([l.list(sig), l.list(sig)])
  assert.deepEqual(x.map(t => t.name), ['b', 'a', 'c'], '不排序'); assert.equal(x, y); assert.equal(calls.length, 2, '两页，并发只取一轮')
  now += 299; await l.list(sig); assert.equal(calls.length, 2, '没过期')
  now += 2; await l.list(sig); assert.equal(calls.length, 4, 'ttl 取最小的 300，过期了重取')
  const d = toolLister(fakeClient([{ tools: [] }]), 100, () => now); await d.list(sig); now += 99; await d.list(sig)
  assert.equal(now, 1000 + 299 + 2 + 99)
})

test('MRTR：只有 requestState 没有 inputRequests → 直接带着 requestState 重发（不带 inputResponses）；没有 requestState 就不带', async () => {
  const sent: Array<Record<string, unknown>> = []
  const client: Client = { connect: async () => undefined, protocol: () => undefined, close: async () => {}, rpc: async (_m, p) => { sent.push(p); return (sent.length === 1 ? { resultType: 'input_required', requestState: 'opaque' } : sent.length === 2 ? { resultType: 'input_required' } : { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] }) as Result } }
  const tool = adapt({ name: 't', inputSchema: { type: 'object' } }, client, { server: 's' })
  assert.equal(text(await run(tool, { a: 1 }, ctxOf())), 'ok')
  assert.deepEqual(sent.map(p => [p.requestState, 'inputResponses' in p]), [[undefined, false], ['opaque', false], [undefined, false]], '第二次返回的没有 requestState，重发就不带')
})

// ───── 用脚本化的假传输测 client 本身 ─────
const scripted = (answer: (m: RpcMessage, n: number) => RpcMessage['result'] | RpcMessage['error'] | 'error:-32022'): Transport & { sent: RpcMessage[] } => {
  const sent: RpcMessage[] = []
  return { kind: 'stdio', sent, close: async () => {}, notify: async () => {}, request: async (m): Promise<Reply> => {
    sent.push(m)
    const a = answer(m, sent.length) as Record<string, unknown>
    return { message: 'code' in a ? { jsonrpc: '2.0', id: m.id, error: a as never } : { jsonrpc: '2.0', id: m.id, result: a } }
  } }
}
const versionOf = (m: RpcMessage) => ((m.params as { _meta: Record<string, unknown> })._meta)['io.modelcontextprotocol/protocolVersion']

test('client：会话中途 server 不再支持当前版本（-32022）→ 换成 supported 里我们会说的版本重发，之后都用新版本', async () => {
  const t = scripted((m, n) => m.method === 'server/discover' ? { supportedVersions: ['2099-01-01', '2026-07-28'] }
    : versionOf(m) === '2099-01-01' ? { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2099-01-01' } } : { resultType: 'complete', n })
  const c = createClient(t, { versions: ['2099-01-01', '2026-07-28'] }); const signal = new AbortController().signal
  await c.rpc('tools/list', {}, { signal }); await c.rpc('tools/list', {}, { signal })
  assert.deepEqual(t.sent.map(versionOf), ['2099-01-01', '2099-01-01', '2026-07-28', '2026-07-28'])
  assert.equal(new Set(t.sent.map(m => m.id)).size, 4, '重发用新 ID')
})

test('client：缺 resultType 的结果被规范化成 complete；server 的 JSON-RPC 错误变成 McpError', async () => {
  const t = scripted(m => m.method === 'server/discover' ? { supportedVersions: ['2026-07-28'] } : m.method === 'a' ? { x: 1 } : { code: -32602, message: 'bad', data: { why: 1 } })
  const c = createClient(t); const signal = new AbortController().signal
  assert.deepEqual(await c.rpc('a', {}, { signal }), { x: 1, resultType: 'complete' })
  await assert.rejects(c.rpc('b', {}, { signal }), (e: unknown) => (e as { code: number; data: unknown }).code === -32602 && JSON.stringify((e as { data: unknown }).data) === '{"why":1}')
})
