import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { otlpHttp, toOtlp } from '../src/index.js'
import type { Span } from '../src/index.js'

const span = (over: Partial<Span> = {}): Span => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'chat m', kind: 'client', startMs: 1_700_000_000_123, endMs: 1_700_000_000_623, attributes: {}, events: [], ...over })
const sig = () => new AbortController().signal
const resource = { serviceName: 'hue-test' }

test('OTLP JSON 编码:ID 十六进制串、时间纳秒字符串、枚举是整数、整数属性是字符串、驼峰字段名', () => {
  const s = span({ parentSpanId: 'c'.repeat(16), attributes: { s: 'x', i: 3, f: 0.5, b: true, arr: ['stop', 'length'] }, events: [{ name: 'e', atMs: 1_700_000_000_200, attributes: { k: 'v' } }], error: { type: 'tool_error', message: 'boom' } })
  const out = toOtlp([s, span({ kind: 'internal', spanId: 'd'.repeat(16) })], { serviceName: 'svc', serviceVersion: '1.2', attributes: { 'deployment.environment': 'test' } })
  const rs = out.resourceSpans[0]!
  assert.deepEqual(rs.resource.attributes, [{ key: 'service.name', value: { stringValue: 'svc' } }, { key: 'service.version', value: { stringValue: '1.2' } }, { key: 'deployment.environment', value: { stringValue: 'test' } }])
  const [a, b] = rs.scopeSpans[0]!.spans as Array<Record<string, any>>
  assert.deepEqual([a!.traceId, a!.spanId, a!.parentSpanId, a!.name, a!.kind, b!.kind, b!.parentSpanId], ['a'.repeat(32), 'b'.repeat(16), 'c'.repeat(16), 'chat m', 3, 1, undefined])
  assert.deepEqual([a!.startTimeUnixNano, a!.endTimeUnixNano], ['1700000000123000000', '1700000000623000000'])
  assert.deepEqual(a!.attributes, [{ key: 's', value: { stringValue: 'x' } }, { key: 'i', value: { intValue: '3' } }, { key: 'f', value: { doubleValue: 0.5 } }, { key: 'b', value: { boolValue: true } },
    { key: 'arr', value: { arrayValue: { values: [{ stringValue: 'stop' }, { stringValue: 'length' }] } } }])
  assert.deepEqual(a!.events, [{ timeUnixNano: '1700000000200000000', name: 'e', attributes: [{ key: 'k', value: { stringValue: 'v' } }] }])
  assert.deepEqual([a!.status, b!.status], [{ code: 2, message: 'boom' }, { code: 0 }])
  assert.equal(JSON.stringify(out).includes('_'), false, '字段名里没有下划线(蛇形)——属性值里的除外,这里没有')
})

// ───── 导出器:对着一个真的 HTTP server ─────

interface Hit { path: string; headers: Record<string, unknown>; body: any }
async function collector(script: Array<{ status: number; headers?: Record<string, string>; body?: string } | 'reset'>) {
  const hits: Hit[] = []; let i = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer)
    hits.push({ path: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    const step = script[Math.min(i++, script.length - 1)]!
    if (step === 'reset') return void req.socket.destroy()
    res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers }); res.end(step.body ?? '{}')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`, hits, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }) }
}
const slept: number[] = []
const sleep = async (ms: number) => { slept.push(ms) }

test('导出器:POST JSON 到给定地址,带 content-type 和自定义头;请求体就是 toOtlp 的输出', async () => {
  const c = await collector([{ status: 200 }])
  try {
    await otlpHttp({ url: c.url, resource, headers: { authorization: 'Bearer t0k' } }).export([span()], sig())
    assert.equal(c.hits.length, 1); assert.equal(c.hits[0]!.path, '/v1/traces'); assert.equal(c.hits[0]!.headers['content-type'], 'application/json'); assert.equal(c.hits[0]!.headers.authorization, 'Bearer t0k')
    assert.deepEqual(c.hits[0]!.body, JSON.parse(JSON.stringify(toOtlp([span()], resource))))
    await otlpHttp({ url: c.url, resource }).export([], sig()); assert.equal(c.hits.length, 1, '没有 span 就不发请求')
  } finally { await c.close() }
})

test('重试:503 / 502 / 504 / 429 和连接被重置都重试,最终成功;退避递增', async () => {
  slept.length = 0
  const c = await collector([{ status: 503 }, { status: 502 }, 'reset', { status: 200 }])
  try {
    await otlpHttp({ url: c.url, resource, sleep, attempts: 5 }).export([span()], sig())
    assert.equal(c.hits.length, 4); assert.equal(slept.length, 3); assert.ok(slept[0]! <= 250 && slept[1]! > slept[0]! * 0.9 && slept[2]! > 250, JSON.stringify(slept))
  } finally { await c.close() }
  for (const status of [429, 504]) { const d = await collector([{ status }, { status: 200 }]); try { await otlpHttp({ url: d.url, resource, sleep }).export([span()], sig()); assert.equal(d.hits.length, 2, String(status)) } finally { await d.close() } }
})

test('Retry-After(秒)优先于退避;超过 60 秒按 60 秒', async () => {
  slept.length = 0
  const c = await collector([{ status: 429, headers: { 'retry-after': '7' } }, { status: 503, headers: { 'retry-after': '9999' } }, { status: 200 }])
  try { await otlpHttp({ url: c.url, resource, sleep }).export([span()], sig()); assert.deepEqual(slept, [7000, 60_000]) } finally { await c.close() }
})

test('不该重试的:400 / 401 / 500 立刻失败,只发一次', async () => {
  for (const status of [400, 401, 500]) {
    const c = await collector([{ status, body: '{"error":"nope"}' }])
    try { await assert.rejects(otlpHttp({ url: c.url, resource, sleep }).export([span()], sig()), new RegExp(`HTTP ${status}.*nope`)); assert.equal(c.hits.length, 1, String(status)) } finally { await c.close() }
  }
})

test('部分成功(200 带 rejectedSpans)不重试,但要报告;rejectedSpans 为 0 算成功', async () => {
  const c = await collector([{ status: 200, body: '{"partialSuccess":{"rejectedSpans":"2","errorMessage":"bad"}}' }])
  try { await assert.rejects(otlpHttp({ url: c.url, resource, sleep }).export([span(), span()], sig()), /rejected 2 of 2/); assert.equal(c.hits.length, 1) } finally { await c.close() }
  const ok = await collector([{ status: 200, body: '{"partialSuccess":{}}' }]); try { await otlpHttp({ url: ok.url, resource }).export([span()], sig()) } finally { await ok.close() }
})

test('一直失败:用完次数后报错,说明试了几次;一直连不上也是', async () => {
  const c = await collector([{ status: 503 }])
  try { await assert.rejects(otlpHttp({ url: c.url, resource, sleep, attempts: 3 }).export([span()], sig()), /gave up after 3 attempts: HTTP 503/); assert.equal(c.hits.length, 3) } finally { await c.close() }
  const url = c.url
  await assert.rejects(otlpHttp({ url, resource, sleep, attempts: 2 }).export([span()], sig()), /gave up after 2 attempts/)
})

test('取消:信号一触发,导出立刻停止,不再重试', async () => {
  const c = await collector([{ status: 503 }]); const ac = new AbortController()
  try {
    const p = otlpHttp({ url: c.url, resource, sleep: (_ms, s) => new Promise((_, rej) => s.addEventListener('abort', () => rej(s.reason))) }).export([span()], ac.signal)
    while (c.hits.length < 1) await new Promise(r => setTimeout(r, 5)); ac.abort(new Error('stop'))
    await assert.rejects(p, /stop/); assert.equal(c.hits.length, 1)
  } finally { await c.close() }
})

test('请求超时当作连接失败重试', async () => {
  const hits: number[] = []
  const server = createServer((_req, res) => { hits.push(1); if (hits.length === 1) return; res.writeHead(200); res.end('{}') }) // 第一次不回
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try { await otlpHttp({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`, resource, sleep, timeoutMs: 100 }).export([span()], sig()); assert.equal(hits.length, 2) } finally { server.closeAllConnections(); server.close() }
})

test('取消(用默认的退避):请求途中被取消,马上返回,不会傻等退避时间', async () => {
  const c = await collector([{ status: 503, headers: { 'retry-after': '30' } }]); const ac = new AbortController()
  try {
    const p = otlpHttp({ url: c.url, resource }).export([span()], ac.signal) // 第一次 503,要等 30 秒才重试
    while (c.hits.length < 1) await new Promise(r => setTimeout(r, 5))
    await new Promise(r => setTimeout(r, 30)); const t0 = Date.now(); ac.abort(new Error('stop'))
    await assert.rejects(p, (e: Error) => e.message === 'stop'); assert.ok(Date.now() - t0 < 1000)
    // 已经取消的信号:错误就是取消原因本身(不是\"重试了几次\"),而且不为退避等一下
    const done = new AbortController(); done.abort(new Error('already')); const t1 = Date.now(); const before = c.hits.length
    await assert.rejects(otlpHttp({ url: c.url, resource }).export([span()], done.signal), (e: Error) => e.message === 'already'); assert.ok(Date.now() - t1 < 100, 'no backoff wait')
    assert.ok(c.hits.length - before <= 1)
  } finally { await c.close() }
})
