// 离线测试：不碰网络。完整链路 = parseSSE → toModelChunks（与线上同一条代码路径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkChunkStream } from '@hue/core/contracts'
import type { ModelChunk } from '@hue/core'
import { parseToolInput, toModelChunks } from '../src/anthropic-events.js'
import { parseSSE } from '../src/sse.js'
import { messageDelta, messageStart, messageStop, ping, packets, reply, textBlock, thinkingBlock, toolBlock, toSSEText, wirePort, type Wire } from './fixtures.js'

const collect = async (it: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> => { const a: ModelChunk[] = []; for await (const c of it) a.push(c); return a }
const wire = async (events: Wire[], packetSize = 11): Promise<ModelChunk[]> =>
  collect(toModelChunks(parseSSE(packets(toSSEText(events), packetSize))))

test('text reply: SSE → chunks，finish 是最后一块，usage 来自 message_start/message_delta', async () => {
  const chunks = await wire(reply([textBlock(0, '旧金山现在 15°C，多云。')], 'end_turn', 16))
  const joined = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(joined, '旧金山现在 15°C，多云。')
  assert.deepEqual(chunks.at(-1), { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 16 } })
  checkChunkStream(chunks)
})

test('11 字节切包：事件和中文都被切碎，解码器负责接回去', async () => {
  const chunks = await wire(reply([textBlock(0, '汉字多字节字符拼接测试')], 'end_turn', 5))
  const joined = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(joined, '汉字多字节字符拼接测试')
})

test('tool call: 参数碎片攒到 block stop 才解析，finishReason=tool-calls', async () => {
  const chunks = await wire(reply([toolBlock(0, 'toolu_01', 'get_weather', { city: 'Paris' })], 'tool_use', 42))
  const calls = chunks.filter(c => c.type === 'tool-call')
  assert.equal(calls.length, 1)
  assert.deepEqual((calls[0] as any).input, { city: 'Paris' })
  assert.equal(chunks.at(-1)!.type, 'finish')
  assert.equal((chunks.at(-1) as any).finishReason, 'tool-calls')
  checkChunkStream(chunks)
})

test('thinking + signature: reasoning-delta → reasoning-end 带签名 providerMetadata', async () => {
  const sig = 'EqQBCgIYAhIM_SIGNATURE'
  const chunks = await wire(reply([thinkingBlock(0, '需要调用工具。', sig)], 'end_turn', 30))
  const end = chunks.find(c => c.type === 'reasoning-end')
  assert.ok(end && end.type === 'reasoning-end')
  assert.deepEqual(end.providerMetadata, { anthropic: { signature: sig } })
  checkChunkStream(chunks)
})

test('thinking + text + tool 三块交错回复', async () => {
  const events = reply([
    thinkingBlock(0, '用户问旧金山天气。', 'SIG_1'),
    textBlock(1, '我来查一下。'),
    toolBlock(2, 'toolu_01', 'get_weather', { city: '旧金山' }),
  ], 'tool_use', 42)
  const chunks = await wire(events)
  const kinds = chunks.map(c => c.type)
  assert.ok(kinds.indexOf('reasoning-end') < kinds.indexOf('tool-call'), 'reasoning 结束要早于 tool-call')
  checkChunkStream(chunks)
})

test('坏 JSON 事件：yield error 并终止（没有 finish）', async () => {
  const raw = 'event: content_block_start\ndata: {"type":"content_block_start", not json\n\n'
  async function* bytes(): AsyncGenerator<Uint8Array> { yield new TextEncoder().encode(raw) }
  const chunks = await collect(toModelChunks(parseSSE(bytes())))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.type, 'error')
  checkChunkStream(chunks)
})

test('流中途断开（没有 message_stop）：error 收尾，不伪造 finish', async () => {
  const truncated = [messageStart(50), ping(), ...textBlock(0, 'half'), messageDelta('end_turn', 3)] // 少 message_stop
  const chunks = await wire(truncated)
  assert.ok(chunks.some(c => c.type === 'text-delta'))
  const last = chunks.at(-1)!
  assert.equal(last.type, 'error')
  assert.match((last as any).error.message, /message_stop/)
  checkChunkStream(chunks)
})

test('message_delta 的 usage 是累计值：覆盖而不是累加', async () => {
  const events: Wire[] = [
    messageStart(10),
    ...textBlock(0, 'hi'),
    messageDelta('end_turn', 5),
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } },
    messageStop(),
  ]
  const chunks = await wire(events)
  const fin = chunks.at(-1)!
  assert.equal(fin.type, 'finish')
  assert.equal((fin as any).usage.outputTokens, 9)
})

test('ping 与未知事件类型被安静忽略', async () => {
  const events: Wire[] = [messageStart(1), ping(), ...textBlock(0, 'x'), { type: 'future_event', foo: 1 }, messageDelta('end_turn', 1), messageStop()]
  const chunks = await wire(events)
  assert.ok(chunks.some(c => c.type === 'text-delta'))
  assert.equal(chunks.at(-1)!.type, 'finish')
})

test('parseToolInput: 空串 → {}；坏 JSON → { __raw }，合同仍通过', async () => {
  assert.deepEqual(parseToolInput(''), {})
  assert.deepEqual(parseToolInput('{"a":1}'), { a: 1 })
  assert.deepEqual(parseToolInput('{"city":'), { __raw: '{"city":' })
  const chunks = await wire(reply([toolBlock(0, 'toolu_02', 'read_file', '{"path":')], 'tool_use', 7))
  const call = chunks.find(c => c.type === 'tool-call') as any
  assert.deepEqual(call.input, { __raw: '{"path":' })
  checkChunkStream(chunks)
})

test('wirePort 回放：port.stream 的输出与合同一致', async () => {
  const port = wirePort([reply([textBlock(0, 'ok')], 'end_turn', 1)])
  const chunks = await collect(port.stream({ instructions: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, new AbortController().signal))
  assert.equal(chunks.at(-1)!.type, 'finish')
  checkChunkStream(chunks)
  assert.equal(port.requests.length, 1)
})

test('finishReason 映射：max_tokens→length，refusal→content-filter，pause_turn→other', async () => {
  for (const [wireReason, expected] of [['max_tokens', 'length'], ['refusal', 'content-filter'], ['pause_turn', 'other']] as const) {
    const chunks = await wire(reply([textBlock(0, 'x')], wireReason, 1))
    assert.equal((chunks.at(-1) as any).finishReason, expected, wireReason)
  }
})

test('message_start 的 cache 字段进 usage', async () => {
  const events: Wire[] = [
    messageStart(100, { cache_read_input_tokens: 55, cache_creation_input_tokens: 7 }),
    ...textBlock(0, 'x'), messageDelta('end_turn', 1), messageStop(),
  ]
  const chunks = await wire(events)
  const fin = chunks.at(-1)!
  assert.deepEqual((fin as any).usage, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 55, cacheWriteTokens: 7 })
})
