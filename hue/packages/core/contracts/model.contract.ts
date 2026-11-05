/**
 * ModelPort 合同。@hue/ai 的每个 provider 都必须过。
 * 两种用法：
 *  1. checkChunkStream(chunks)：纯校验，可对录制的 fixture 跑（CI 不需要 API key）
 *  2. modelPortContract(name, make)：真实调用，没有 key 时 skip
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelChunk, ModelPort } from '../src/index.js'
import { userText } from '../src/index.js'

export function checkChunkStream(chunks: ModelChunk[]): void {
  const fin = chunks.filter(c => c.type === 'finish')
  const err = chunks.filter(c => c.type === 'error')
  assert.ok(fin.length + err.length >= 1, 'stream must end with finish or error')
  assert.ok(fin.length <= 1, 'finish at most once')
  if (fin.length) assert.equal(chunks[chunks.length - 1]!.type, 'finish', 'finish must be last')
  const ids = new Set<string>()
  for (const c of chunks) if (c.type === 'tool-call') {
    assert.ok(!ids.has(c.callId), `duplicate callId ${c.callId}`); ids.add(c.callId)
    assert.equal(typeof c.input, 'object', 'tool-call input must be parsed JSON (or {__raw})')
    JSON.stringify(c.input) // 必须可序列化
  }
  const f = fin[0]
  if (f?.type === 'finish') {
    assert.ok(f.usage.inputTokens >= 0 && f.usage.outputTokens >= 0)
    if (ids.size) assert.equal(f.finishReason, 'tool-calls', 'tool calls → finishReason tool-calls')
  }
  JSON.stringify(chunks) // 整个流可序列化（providerMetadata 必须是 Json）
}

const collect = async (it: AsyncIterable<ModelChunk>) => { const a: ModelChunk[] = []; for await (const c of it) a.push(c); return a }

export function modelPortContract(name: string, make: () => ModelPort | undefined): void {
  const port = make()
  const skip = port ? false : 'no credentials'
  test(`${name}: specVersion + info`, { skip }, () => {
    assert.equal(port!.specVersion, 'hue.model.v1'); assert.ok(port!.info.contextWindow > 0); assert.match(port!.id, /^[a-z0-9-]+:.+/)
  })
  test(`${name}: plain text`, { skip }, async () => {
    const cs = await collect(port!.stream({ instructions: 'Reply with the word ok.', messages: [userText('hi')], tools: [] }, new AbortController().signal))
    checkChunkStream(cs); assert.ok(cs.some(c => c.type === 'text-delta'))
  })
  test(`${name}: forced tool call round-trip`, { skip }, async () => {
    const tools = [{ name: 'get_weather', description: 'weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
    const cs = await collect(port!.stream({ instructions: '', messages: [userText('Weather in Paris?')], tools, toolChoice: { name: 'get_weather' } }, new AbortController().signal))
    checkChunkStream(cs)
    const call = cs.find(c => c.type === 'tool-call'); assert.ok(call && call.type === 'tool-call')
    // 第二轮：把结果喂回去，必须被 provider 接受（验证消息转换 + providerMetadata 往返）
    const content: any[] = cs.filter(c => c.type === 'tool-call').map(c => ({ ...c, type: 'tool-call' }))
    const cs2 = await collect(port!.stream({ instructions: '', tools, messages: [userText('Weather in Paris?'),
      { role: 'assistant', content: content.map(({ callId, name, input, providerMetadata }) => ({ type: 'tool-call', callId, name, input, providerMetadata })) },
      { role: 'tool', content: [{ type: 'tool-result', callId: call.callId, name: 'get_weather', isError: false, content: [{ type: 'text', text: 'sunny, 21C' }] }] }] }, new AbortController().signal))
    checkChunkStream(cs2); assert.ok(cs2.some(c => c.type === 'finish'))
  })
  test(`${name}: abort stops the stream`, { skip }, async () => {
    const ac = new AbortController(); let n = 0
    await assert.rejects(async () => { for await (const _ of port!.stream({ instructions: '', messages: [userText('Count from 1 to 500.')], tools: [] }, ac.signal)) if (++n === 2) ac.abort() },
      (e: any) => e?.name === 'AbortError')
  })
}
