import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EventStore, HueEvent } from '@hue/core'
import { exportSession, observeStore, telemetry } from '../src/index.js'
import type { Exporter, Span } from '../src/index.js'
import { ev } from './helpers.js'

function memExporter(opts: { fail?: boolean; delayMs?: number } = {}) {
  const batches: Span[][] = []; let inflight = 0, maxInflight = 0
  const exporter: Exporter = { async export(spans) {
    maxInflight = Math.max(maxInflight, ++inflight)
    try { if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs)); if (opts.fail) throw new Error('collector down'); batches.push(spans) } finally { inflight-- }
  } }
  return { exporter, batches, all: () => batches.flat(), maxInflight: () => maxInflight }
}
const turnEvents = (t: string, at = 0): HueEvent[] => [ev.turn({ turnId: t, at }), ev.model({ turnId: t, at: at + 5 }), ev.end('stop', { turnId: t, at: at + 6 })]

test('必须给 url 或 exporter', () => { assert.throws(() => telemetry({}), /url.*exporter/) })

test('flush 发出已经结束的 span;没结束的不动,直到 endOpen / shutdown', async () => {
  const m = memExporter(); const t = telemetry({ exporter: m.exporter, intervalMs: 60_000 })
  for (const e of [ev.turn({ at: 0 }), ev.call('c', { at: 1 })]) t.onEvent(e)
  await t.flush(); assert.equal(m.all().length, 0)
  t.onEvent(ev.result('c', { at: 3 })); await t.flush(); assert.deepEqual(m.all().map(s => s.name), ['execute_tool bash'])
  await t.flush({ endOpen: true }); assert.deepEqual(m.all().map(s => [s.name, s.error?.type]), [['execute_tool bash', undefined], ['invoke_agent', 'unfinished']])
  await t.shutdown()
})

test('攒够 batchSize 就发,不用等定时器;每批不超过 batchSize', async () => {
  const m = memExporter(); const t = telemetry({ exporter: m.exporter, batchSize: 3, intervalMs: 60_000 })
  for (let i = 0; i < 4; i++) turnEvents(`t${i}`, i * 10).forEach(e => t.onEvent(e)) // 8 个 span
  await t.flush(); assert.deepEqual(m.batches.map(b => b.length), [3, 3, 2])
  await t.shutdown()
})

test('定时器:没攒够也会按 intervalMs 发出去', async () => {
  const m = memExporter(); const t = telemetry({ exporter: m.exporter, intervalMs: 30 })
  turnEvents('t').forEach(e => t.onEvent(e))
  const t0 = Date.now(); while (m.all().length < 2 && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 10))
  assert.equal(m.all().length, 2); await t.shutdown()
})

test('导出失败只通知 onError,不抛、不影响后面的批次;onError 自己抛错也无妨', async () => {
  const m = memExporter({ fail: true }); const errors: string[] = []
  const t = telemetry({ exporter: m.exporter, batchSize: 2, intervalMs: 60_000, onError: e => { errors.push(e.message); throw new Error('callback broke') } })
  for (let i = 0; i < 3; i++) turnEvents(`t${i}`, i * 10).forEach(e => t.onEvent(e))
  await t.flush(); assert.deepEqual(errors, ['collector down', 'collector down', 'collector down']); await t.shutdown()
})

test('发送是串行的:前一批没发完,后一批等着', async () => {
  const m = memExporter({ delayMs: 20 }); const t = telemetry({ exporter: m.exporter, batchSize: 1, intervalMs: 60_000 })
  for (let i = 0; i < 3; i++) turnEvents(`t${i}`, i * 10).forEach(e => t.onEvent(e))
  await t.flush(); assert.equal(m.maxInflight(), 1); assert.equal(m.all().length, 6); await t.shutdown()
})

test('队列有上限:导出器慢到跟不上时丢最老的并计数,onEvent 始终立刻返回', async () => {
  const m = memExporter({ delayMs: 200 }); const dropped: string[] = []
  const t = telemetry({ exporter: m.exporter, batchSize: 1000, maxQueue: 5, intervalMs: 60_000, onError: e => dropped.push(e.message) })
  const t0 = Date.now()
  for (let i = 0; i < 10; i++) turnEvents(`t${i}`, i * 10).forEach(e => t.onEvent(e)) // 20 个 span
  assert.ok(Date.now() - t0 < 100, 'onEvent 不等导出'); assert.equal(t.dropped, 15); assert.match(dropped[0]!, /dropped 1 oldest/)
  await t.flush(); assert.equal(m.all().length, 5); assert.equal(m.all()[0]!.attributes['gen_ai.conversation.id'], 's')
  assert.equal(m.all().filter(s => s.name === 'invoke_agent').length, 3, '留下的是最新的那批')
  await t.shutdown()
})

test('onEvent 永不抛:坏事件(缺字段)被吞掉并报告', () => {
  const errors: Error[] = []; const t = telemetry({ exporter: memExporter().exporter, onError: e => errors.push(e), intervalMs: 60_000 })
  assert.doesNotThrow(() => t.onEvent({ type: 'tool.result', sessionId: 's', at: 1 } as unknown as HueEvent)); assert.doesNotThrow(() => t.onEvent(null as unknown as HueEvent))
  assert.ok(errors.length >= 1); void t.shutdown()
})

test('shutdown 之后收到的事件被忽略;shutdown 会收尾没结束的', async () => {
  const m = memExporter(); const t = telemetry({ exporter: m.exporter, intervalMs: 60_000 })
  t.onEvent(ev.turn({ at: 0 })); await t.shutdown(); assert.deepEqual(m.all().map(s => s.error?.type), ['unfinished'])
  turnEvents('late').forEach(e => t.onEvent(e)); await t.flush(); assert.equal(m.all().length, 1)
})

test('exportSession:读一个会话的日志补导出,收尾没结束的,返回事件数', async () => {
  const log = [ev.created({ at: 0 }), ...turnEvents('t', 1), ev.turn({ turnId: 'crashed', at: 50 })]
  const store: EventStore = { specVersion: 'hue.store.v1', append: async () => {}, lastSeq: async () => log.length, async *read(id) { for (const e of log) if (e.sessionId === id) yield e } }
  const m = memExporter(); const t = telemetry({ exporter: m.exporter, intervalMs: 60_000 })
  assert.equal(await exportSession(store, 's', t), log.length)
  assert.deepEqual(m.all().map(s => [s.name, s.error?.type]), [['chat claude-x', undefined], ['invoke_agent', undefined], ['invoke_agent', 'unfinished']])
  await t.shutdown()
})

test('url 模式:用内置的 OTLP/HTTP 导出器发到那个地址,resource 里有 service.name', async () => {
  const bodies: any[] = []
  const t = telemetry({ url: 'http://collector.test/v1/traces', serviceName: 'my-agent', intervalMs: 60_000, fetch: (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response('{}', { status: 200 }) }) as typeof fetch })
  turnEvents('t').forEach(e => t.onEvent(e)); await t.shutdown()
  assert.equal(bodies.length, 1); assert.deepEqual(bodies[0].resourceSpans[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'my-agent' } }]); assert.equal(bodies[0].resourceSpans[0].scopeSpans[0].spans.length, 2)
})

test('observeStore:落盘成功之后才上报;落盘失败的事件不进 trace;读和 lastSeq 原样透传', async () => {
  const written: HueEvent[] = []; let fail = false
  const store: EventStore = { specVersion: 'hue.store.v1', append: async es => { if (fail) throw new Error('disk full'); written.push(...es) }, lastSeq: async () => 42, async *read() { yield ev.turn() } }
  const m = memExporter(); const t = telemetry({ exporter: m.exporter, intervalMs: 60_000 }); const obs = observeStore(store, t)
  await obs.append(turnEvents('ok')); fail = true
  await assert.rejects(obs.append(turnEvents('lost', 10)), /disk full/)
  await t.flush(); assert.equal(written.length, 3); assert.equal(m.all().length, 2)
  assert.equal(await obs.lastSeq('s'), 42); assert.equal((await (async () => { let n = 0; for await (const _ of obs.read('s')) n++; return n })()), 1); assert.equal(obs.specVersion, 'hue.store.v1'); await t.shutdown()
})
