import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { textResult } from '@hue/core'
import type { HueEvent, ModelChunk, ModelPort, Tool } from '@hue/core'
import { createGateway } from '@hue/gateway'
import { rules } from '@hue/policy'
import { createAgent } from '@hue/runtime'
import { sqliteStore } from '@hue/store'

const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 5, outputTokens: 5 } })
const model = (steps: ModelChunk[][]): ModelPort => {
  let i = 0
  return { specVersion: 'hue.model.v1', id: 'mock:1', info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream() { for (const c of steps[i++] ?? [{ type: 'text-delta', text: 'done' } as ModelChunk, fin('stop')]) yield c } }
}
const deploy: Tool = { name: 'deploy', description: 'Deploy to production', inputSchema: { type: 'object' }, effects: 'unsafe', async execute() { return textResult('deployed') } }
const TOKEN = 'integration-token-0123456789'

async function boot(steps: ModelChunk[][]) {
  const store = sqliteStore(join(mkdtempSync(join(tmpdir(), 'hue-gw-')), 'hue.db'))
  // 真 runtime + 真 policy（unsafe 的工具要问）+ 真 sqlite；人的回答从 HTTP 回来
  const gateway = createGateway({ store, tokens: [TOKEN], agent: input => createAgent({ model: model(steps), store, tools: [deploy], policy: rules([{ effects: 'unsafe', action: 'ask' }], { default: 'allow' }), input }) })
  const { url } = await gateway.listen(0)
  const h = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const events = async (id: string, until: (e: HueEvent) => boolean) => {
    const res = await fetch(`${url}/v1/sessions/${id}/events`, { headers: h }), out: HueEvent[] = []
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = ''
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      buf += dec.decode(value, { stream: true })
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const data = block.split('\n').find(l => l.startsWith('data: ')); if (!data) continue
        const e = JSON.parse(data.slice(6)) as HueEvent; out.push(e); if (until(e)) { await reader.cancel(); return out }
      }
    }
    return out
  }
  return { url, h, store, gateway, events, close: async () => { await gateway.close(); store.close() } }
}

test('端到端（真 runtime + policy + sqlite）：HTTP 发任务 → 工具要批准 → 事件流里看到请求 → HTTP 批准 → 工具执行 → turn 结束；日志里是完整的一份', { timeout: 20_000 }, async () => {
  const t = await boot([[{ type: 'tool-call', callId: 'c1', name: 'deploy', input: {} }, fin('tool-calls')], [{ type: 'text-delta', text: 'deployed it' }, fin('stop')]])
  try {
    const watching = t.events('s1', e => e.type === 'turn.ended')
    assert.equal((await fetch(`${t.url}/v1/sessions/s1/messages`, { method: 'POST', headers: t.h, body: JSON.stringify({ text: 'ship it' }) })).status, 202)
    // 等到 input.requested 出现在会话状态里（pendingInputs），再批准
    let pending: string[] = []
    for (let i = 0; i < 100 && !pending.length; i++) { await new Promise(r => setTimeout(r, 20)); pending = ((await (await fetch(`${t.url}/v1/sessions/s1`, { headers: t.h })).json()) as any).pendingInputs ?? [] }
    assert.equal(pending.length, 1)
    assert.equal((await fetch(`${t.url}/v1/sessions/s1/inputs/${pending[0]}`, { method: 'POST', headers: t.h, body: JSON.stringify({ action: 'accept' }) })).status, 200)
    const seen = await watching
    const kinds = seen.map(e => e.type)
    for (const k of ['session.created', 'input.requested', 'input.resolved', 'tool.call', 'tool.result', 'turn.ended']) assert.ok(kinds.includes(k as never), `missing ${k}: ${kinds.join(',')}`)
    assert.ok(kinds.indexOf('input.requested') < kinds.indexOf('tool.result'))
    const result = seen.find(e => e.type === 'tool.result')!; assert.ok(result.type === 'tool.result' && !result.isError && JSON.stringify(result.content).includes('deployed'))
    // 稍后重连、从中间续：拿到的是日志里剩下的 durable 事件
    const lastSeq = seen.filter(e => e.seq > 0).at(-1)!.seq
    const tail = await t.events('s1', e => e.seq === lastSeq || false); assert.equal(tail.at(-1)!.seq, lastSeq)
  } finally { await t.close() }
})

test('端到端：用户拒绝 → 工具没执行，模型收到被拒绝的结果；等批准时打断 → 按取消处理，turn 以 interrupted 结束', { timeout: 20_000 }, async () => {
  const call = (id: string) => [{ type: 'tool-call', callId: id, name: 'deploy', input: {} } as ModelChunk, fin('tool-calls')]
  const steps = [call('c1'), [{ type: 'text-delta', text: 'ok, not deploying' } as ModelChunk, fin('stop')], call('c2')] // 模型按调用顺序消费脚本：a 两次，b 一次
  const t = await boot(steps)
  try {
    const wait = async (id: string) => { for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 20)); const p = ((await (await fetch(`${t.url}/v1/sessions/${id}`, { headers: t.h })).json()) as any).pendingInputs; if (p?.length) return p[0] as string } throw new Error('no pending input') }
    const post = (path: string, body: object) => fetch(`${t.url}${path}`, { method: 'POST', headers: t.h, body: JSON.stringify(body) })

    const a = t.events('a', e => e.type === 'turn.ended'); await post('/v1/sessions/a/messages', { text: 'go' })
    await post(`/v1/sessions/a/inputs/${await wait('a')}`, { action: 'decline', reason: 'not now' })
    const seenA = await a; const resA = seenA.find(e => e.type === 'tool.result')!
    assert.ok(resA.type === 'tool.result' && resA.isError && resA.synthetic === 'denied' && JSON.stringify(resA.content).includes('not now'))

    const b = t.events('b', e => e.type === 'turn.ended'); await post('/v1/sessions/b/messages', { text: 'go' }); await wait('b')
    assert.equal((await post('/v1/sessions/b/interrupt', {})).status, 202)
    const end = (await b).at(-1)!; assert.ok(end.type === 'turn.ended' && end.reason === 'interrupted', JSON.stringify(end))
  } finally { await t.close() }
})

test('端到端：close() 时正在等批准的会话被打断收尾，日志里没有悬空的 tool.call', { timeout: 20_000 }, async () => {
  const t = await boot([[{ type: 'tool-call', callId: 'c1', name: 'deploy', input: {} }, fin('tool-calls')]])
  await fetch(`${t.url}/v1/sessions/s1/messages`, { method: 'POST', headers: t.h, body: JSON.stringify({ text: 'go' }) })
  for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 20)); if (((await (await fetch(`${t.url}/v1/sessions/s1`, { headers: t.h })).json()) as any).pendingInputs?.length) break }
  await t.gateway.close()
  const log: HueEvent[] = []; for await (const e of t.store.read('s1')) log.push(e)
  t.store.close()
  const calls = log.filter(e => e.type === 'tool.call').map(e => (e as any).callId), results = log.filter(e => e.type === 'tool.result').map(e => (e as any).callId)
  assert.deepEqual(calls, results); assert.equal(log.at(-1)!.type, 'turn.ended')
})
