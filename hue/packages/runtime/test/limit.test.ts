import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Capability, EventStore, HueEvent, Message, ModelChunk, ModelPort, Tool, ToolContent } from '@hue/core'
import { createAgent, drain, limitContent } from '../src/index.js'

const bytes = (s: string) => new TextEncoder().encode(s).length
const textOf = (c: ToolContent[]) => c.map(p => (p.type === 'text' ? p.text : '')).join('')

test('limitContent：没超不动；超了保留头尾、标明省略量，结果不超过上限', () => {
  const small: ToolContent[] = [{ type: 'text', text: 'hello' }]
  assert.equal(limitContent(small, 100)[0], small[0], '没超的原样返回同一个对象')
  const big = 'HEAD' + 'x'.repeat(5000) + 'TAIL'
  const [out] = limitContent([{ type: 'text', text: big }], 1000)
  assert.equal(out!.type, 'text')
  const t = (out as { text: string }).text
  assert.ok(bytes(t) <= 1000, `长度 ${bytes(t)}`)
  assert.match(t, /^HEAD/); assert.match(t, /TAIL$/); assert.match(t, /\d+ bytes omitted/)
  const omitted = Number(/(\d+) bytes omitted/.exec(t)![1])
  assert.equal(omitted + bytes(t.replace(/\n\[\.\.\. \d+ bytes omitted[^\n]*\n/, '')), bytes(big), '省略量 + 留下的 == 原长')
})

test('limitContent：按字节算，多字节字符不会被切成 �', () => {
  const big = '中'.repeat(3000) // 9000 字节
  const t = textOf(limitContent([{ type: 'text', text: big }], 1001))
  assert.ok(bytes(t) <= 1001); assert.ok(!t.includes('�'))
})

test('limitContent：多块合计算预算；json 块超了变成文本；文件块不动', () => {
  const file: ToolContent = { type: 'file', url: 'data:image/png;base64,AAAA', mediaType: 'image/png' } as ToolContent
  const out = limitContent([{ type: 'text', text: 'a'.repeat(600) }, { type: 'json', value: { k: 'b'.repeat(2000) } }, file], 1000)
  assert.equal(out[0]!.type, 'text'); assert.equal((out[0] as { text: string }).text.length, 600, '第一块在预算内')
  assert.equal(out[1]!.type, 'text'); assert.match((out[1] as { text: string }).text, /omitted/)
  assert.equal(out[2], file)
})

// ═════════ 接进 agent：普通工具和 capability 的工具都被包住，isError 和 data 保留 ═════════
function memStore(): EventStore & { events: HueEvent[] } {
  const events: HueEvent[] = []
  return {
    specVersion: 'hue.store.v1', events,
    async append(es: HueEvent[]) { events.push(...structuredClone(es)) },
    async *read(sessionId: string) { for (const e of events) if (e.sessionId === sessionId) yield structuredClone(e) },
    async lastSeq(sessionId: string) { return events.filter(e => e.sessionId === sessionId).length },
  }
}
const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 1, outputTokens: 1 } })
function scripted(steps: ModelChunk[][]): ModelPort & { requests: Message[][] } {
  let i = 0; const requests: Message[][] = []
  return {
    specVersion: 'hue.model.v1', id: 'mock:1', requests,
    info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(req) { requests.push(structuredClone(req.messages)); for (const c of steps[i++] ?? [{ type: 'text-delta', text: 'ok' }, fin('stop')]) yield c },
  }
}
const huge = 'S' + 'y'.repeat(300_000) + 'E'
const loud = (name: string): Tool => ({
  name, description: name, inputSchema: { type: 'object' }, effects: 'none',
  async execute() { return { content: [{ type: 'text', text: huge }], isError: true, data: { raw: 'kept' } } },
})
const twoCalls: ModelChunk[][] = [
  [{ type: 'tool-call', callId: 'c1', name: 'direct', input: {} }, { type: 'tool-call', callId: 'c2', name: 'viacap', input: {} }, fin('tool-calls')],
  [{ type: 'text-delta', text: 'ok' }, fin('stop')],
]

test('agent：默认 100 KB 上限包住普通工具和 capability 的工具；isError 与 data 原样保留', async () => {
  const cap: Capability = { name: 'cap', tools: () => [loud('viacap')] }
  const store = memStore(); const model = scripted(twoCalls)
  await drain(createAgent({ model, store, tools: [loud('direct')], capabilities: [cap] }).run('go', { sessionId: 's' }))
  const results = store.events.filter((e): e is Extract<HueEvent, { type: 'tool.result' }> => e.type === 'tool.result')
  assert.equal(results.length, 2)
  for (const r of results) {
    const t = textOf(r.content)
    assert.ok(bytes(t) <= 100_000, `${r.name} ${bytes(t)}`); assert.match(t, /^S/); assert.match(t, /E$/); assert.match(t, /omitted by the runtime output limit/)
    assert.equal(r.isError, true); assert.deepEqual(r.data, { raw: 'kept' })
  }
  const toolMsg = model.requests[1]!.filter(m => m.role === 'tool')
  assert.ok(toolMsg.length > 0 && JSON.stringify(toolMsg).length < 250_000, '发给模型的也是截过的')
})

test('agent：maxToolOutputBytes 可调；Infinity 关掉', async () => {
  const run = async (maxToolOutputBytes: number) => {
    const store = memStore()
    await drain(createAgent({ model: scripted(twoCalls), store, tools: [loud('direct'), loud('viacap')], maxToolOutputBytes }).run('go', { sessionId: 's' }))
    return store.events.filter((e): e is Extract<HueEvent, { type: 'tool.result' }> => e.type === 'tool.result').map(r => bytes(textOf(r.content)))
  }
  assert.ok((await run(2000)).every(n => n <= 2000))
  assert.ok((await run(Infinity)).every(n => n === bytes(huge)))
})
