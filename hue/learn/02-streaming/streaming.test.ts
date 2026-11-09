import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Tool } from '../01-minimal-loop/loop.js'
import { parseToolInput, toChunks } from './anthropic.js'
import { chunkModel, messageDelta, messageStart, messageStop, ping, reply, textBlock, thinkingBlock, toolBlock, toSSEText, packets, wireModel } from './fixtures.js'
import { drain, streamingLoop } from './loop.js'
import { parseSSE } from './sse.js'
import type { Chunk, Message, ToolMessage } from './types.js'

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => { const out: T[] = []; for await (const x of it) out.push(x); return out }
const chunksOf = (events: ReturnType<typeof reply>, packetSize: number) => collect(toChunks(parseSSE(packets(toSSEText(events), packetSize))))
const echo: Tool = { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, async execute(i) { return `echo:${JSON.stringify(i)}` } }
const base = { system: 's', prompt: 'hi', tools: [echo] }

// ═════════ 第一层：SSE 解析 ═════════

test('SSE：不管怎么切包，解析结果都一样（含被切开的中文字节）', async () => {
  const text = toSSEText([{ type: 'a', v: '你好，世界 🌍' }, { type: 'b', v: 'x' }])
  const expected = await collect(parseSSE(packets(text, 1000)))
  assert.equal(expected.length, 2)
  for (const size of [1, 2, 3, 5, 7, 13]) {
    assert.deepEqual(await collect(parseSSE(packets(text, size))), expected, `packetSize=${size}`)
  }
  assert.equal(JSON.parse(expected[0]!.data).v, '你好，世界 🌍')
})

test('SSE：忽略注释行；末尾没有空行收尾的半个事件被丢弃', async () => {
  const text = ': keep-alive\n\nevent: x\ndata: {"ok":1}\n\nevent: y\ndata: {"half":'
  const msgs = await collect(parseSSE(packets(text, 4)))
  assert.deepEqual(msgs.map(m => m.event), ['x'])
})

// ═════════ 第二层：Anthropic 事件 → Chunk ═════════

test('适配器：文本。delta 逐块到达，finish 恰好一次且最后', async () => {
  const chunks = await chunksOf(reply([textBlock(0, '你好，世界')], 'end_turn', 7), 9)
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join(''), '你好，世界')
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
  assert.equal(chunks.at(-1)!.type, 'finish')
})

test('适配器：tool_use 的 partial_json 攒到 stop 才解析，只发一次 tool-call', async () => {
  const chunks = await chunksOf(reply([toolBlock(0, 't1', 'echo', { location: 'San Francisco, CA', unit: 'c' })], 'tool_use', 20), 6)
  const calls = chunks.filter(c => c.type === 'tool-call') as Extract<Chunk, { type: 'tool-call' }>[]
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.input, { location: 'San Francisco, CA', unit: 'c' })
  assert.ok(chunks.filter(c => c.type === 'tool-input-delta').length > 1, '参数应当是被分成多个碎片到达的')
  // tool-call 一定出现在 finish 之前
  assert.ok(chunks.findIndex(c => c.type === 'tool-call') < chunks.findIndex(c => c.type === 'finish'))
})

test('适配器：无参数工具（空 partial_json）→ input 是 {}', async () => {
  const chunks = await chunksOf(reply([toolBlock(0, 't1', 'now', {})], 'tool_use', 5), 8)
  assert.deepEqual((chunks.find(c => c.type === 'tool-call') as { input: unknown }).input, {})
})

test('适配器：参数被截断 → input = { __raw }，不抛错', async () => {
  const chunks = await chunksOf(reply([toolBlock(0, 't1', 'echo', '{"path":"/usr/lo')], 'max_tokens', 99), 8)
  assert.deepEqual((chunks.find(c => c.type === 'tool-call') as { input: unknown }).input, { __raw: '{"path":"/usr/lo' })
  assert.deepEqual(parseToolInput('not json'), { __raw: 'not json' })
})

test('适配器：推理块 → reasoning-end 带上签名', async () => {
  const chunks = await chunksOf(reply([thinkingBlock(0, '先算 1071 = 2×462 + 147', 'SIG_abc'), textBlock(1, '答案是 21')], 'end_turn', 30), 10)
  const end = chunks.find(c => c.type === 'reasoning-end') as Extract<Chunk, { type: 'reasoning-end' }>
  assert.deepEqual(end.providerMetadata, { anthropic: { signature: 'SIG_abc' } })
  assert.ok(chunks.findIndex(c => c.type === 'reasoning-end') < chunks.findIndex(c => c.type === 'text-delta'))
})

test('适配器：usage 的 output_tokens 是累计值，覆盖而不是累加', async () => {
  const events = [messageStart(100, { cache_read_input_tokens: 80 }), ...textBlock(0, 'hi'), messageDelta('end_turn', 5), messageDelta('end_turn', 12), messageStop()]
  const fin = (await chunksOf(events, 50)).at(-1) as Extract<Chunk, { type: 'finish' }>
  assert.deepEqual(fin.usage, { inputTokens: 100, outputTokens: 12, cacheReadTokens: 80 })
})

test('适配器：stop_reason 映射', async () => {
  const reasons = async (r: string) => ((await chunksOf(reply([textBlock(0, 'x')], r, 1), 50)).at(-1) as { finishReason: string }).finishReason
  assert.equal(await reasons('end_turn'), 'stop')
  assert.equal(await reasons('tool_use'), 'tool-calls')
  assert.equal(await reasons('max_tokens'), 'length')
  assert.equal(await reasons('refusal'), 'content-filter')
  assert.equal(await reasons('something_new'), 'other')
})

test('适配器：未知事件和未知内容块被安静地忽略', async () => {
  const events = [messageStart(), { type: 'brand_new_event' }, { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use' } }, { type: 'content_block_delta', index: 0, delta: { type: 'x' } }, { type: 'content_block_stop', index: 0 }, ...textBlock(1, 'ok'), messageDelta('end_turn', 3), messageStop()]
  const chunks = await chunksOf(events, 40)
  assert.equal(chunks.at(-1)!.type, 'finish')
  assert.equal(chunks.filter(c => c.type === 'error').length, 0)
})

test('适配器：流中途收到 error 事件 → 以 error 收尾，没有 finish', async () => {
  const events = [messageStart(), ...textBlock(0, 'partial'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]
  const chunks = await chunksOf(events, 30)
  assert.equal(chunks.at(-1)!.type, 'error')
  assert.match((chunks.at(-1) as { message: string }).message, /overloaded_error/)
  assert.equal(chunks.filter(c => c.type === 'finish').length, 0)
})

test('适配器：没看到 message_stop 就断流 → error，不能当成正常结束', async () => {
  const chunks = await chunksOf([messageStart(), ...textBlock(0, 'cut off here')], 30)
  assert.equal(chunks.at(-1)!.type, 'error')
  assert.equal(chunks.filter(c => c.type === 'finish').length, 0)
})

// ═════════ 第三层：流式 loop（用 wireModel 走完整链路）═════════

test('loop：端到端 —— 推理 + 文本 + 工具调用，签名原样进入历史', async () => {
  const model = wireModel([
    reply([thinkingBlock(0, '需要查一下', 'SIG_1'), textBlock(1, '我来查。'), toolBlock(2, 'toolu_1', 'echo', { q: '天气' })], 'tool_use', 40),
    reply([textBlock(0, '查到了。')], 'end_turn', 8),
  ])
  const [events, r] = await drain(streamingLoop({ ...base, model }))
  assert.equal(r.reason, 'stop')
  assert.equal(r.steps, 2)
  assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0 })
  // 第 1 步的 assistant 消息：推理（带签名）→ 文本 → 工具调用，顺序与流中一致
  const first = r.messages[1] as Extract<Message, { role: 'assistant' }>
  assert.deepEqual(first.content.map(p => p.type), ['reasoning', 'text', 'tool-call'])
  assert.deepEqual((first.content[0] as { providerMetadata: unknown }).providerMetadata, { anthropic: { signature: 'SIG_1' } })
  // 第 2 次请求把推理块（含签名）原样发回
  const second = model.requests[1]!.messages[1] as Extract<Message, { role: 'assistant' }>
  assert.deepEqual((second.content[0] as { providerMetadata: unknown }).providerMetadata, { anthropic: { signature: 'SIG_1' } })
  assert.ok(events.some(e => e.type === 'text-delta'))
})

test('loop：增量事件拼起来 = 最终消息里的文本', async () => {
  const model = wireModel([reply([textBlock(0, '一二三四五六七八九十')], 'end_turn', 10)], 7)
  const [events, r] = await drain(streamingLoop({ ...base, model }))
  const streamed = events.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('')
  assert.equal(streamed, '一二三四五六七八九十')
  assert.deepEqual((r.messages[1] as { content: unknown }).content, [{ type: 'text', text: streamed }])
})

test('loop：参数被截断（stop_reason=max_tokens）→ 不执行工具，历史里没有悬空 tool-call', async () => {
  let executed = false
  const spy: Tool = { ...echo, async execute() { executed = true; return '' } }
  const model = wireModel([reply([textBlock(0, '我来写文件'), toolBlock(1, 't1', 'echo', '{"path":"/usr/lo')], 'max_tokens', 99)])
  const [, r] = await drain(streamingLoop({ ...base, tools: [spy], model }))
  assert.equal(r.reason, 'length')
  assert.equal(executed, false)
  assert.deepEqual(r.messages.at(-1), { role: 'assistant', content: [{ type: 'text', text: '我来写文件' }] })
})

test('loop：参数坏了但 stop_reason 正常 → 变成 isError 结果回给模型，模型下一步重试', async () => {
  const model = wireModel([
    reply([toolBlock(0, 't1', 'echo', '{"a":')], 'tool_use', 9), // 坏 JSON，但服务端说这是一次正常的工具调用
    reply([toolBlock(0, 't2', 'echo', { a: 1 })], 'tool_use', 9),
    reply([textBlock(0, '好了')], 'end_turn', 3),
  ])
  const [, r] = await drain(streamingLoop({ ...base, model }))
  assert.equal(r.reason, 'stop')
  const tm = model.requests[1]!.messages[2] as ToolMessage
  assert.equal(tm.content[0]!.isError, true)
  assert.match(tm.content[0]!.text, /not valid JSON/)
})

test('loop：流中途断开 → 只保留已完整的文本，丢掉半截的 tool-call 和推理', async () => {
  const model = wireModel([[messageStart(), ...thinkingBlock(0, '想', 'S'), ...textBlock(1, '已完整的文本'), ...toolBlock(2, 't1', 'echo', { x: 1 }).slice(0, 2) /* 没有 stop */]])
  const [, r] = await drain(streamingLoop({ ...base, model }))
  assert.equal(r.reason, 'error')
  assert.match(r.error!, /message_stop/)
  assert.deepEqual(r.messages.at(-1), { role: 'assistant', content: [{ type: 'text', text: '已完整的文本' }] })
})

test('loop：服务端 error 事件 → reason=error，带上原因', async () => {
  const model = wireModel([[messageStart(), ...textBlock(0, 'abc'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]])
  const [, r] = await drain(streamingLoop({ ...base, model }))
  assert.equal(r.reason, 'error')
  assert.match(r.error!, /overloaded_error/)
})

test('loop：流式过程中取消 → reason=aborted，已收到的完整文本保留', async () => {
  const ac = new AbortController()
  const model = wireModel([reply([textBlock(0, '一段很长很长很长的回复内容', 2)], 'end_turn', 20)], 6)
  const gen = streamingLoop({ ...base, model, signal: ac.signal })
  let n = 0
  let result
  while (true) {
    const x = await gen.next()
    if (x.done) { result = x.value; break }
    if (x.value.type === 'text-delta' && ++n === 3) ac.abort()
  }
  assert.equal(result.reason, 'aborted')
  assert.equal(result.messages.at(-1)!.role, 'assistant')
})

test('loop：拒答 → reason=stop 但 finishReason=content-filter，可以区分', async () => {
  const model = wireModel([reply([textBlock(0, '我不能帮你')], 'refusal', 4)])
  const [, r] = await drain(streamingLoop({ ...base, model }))
  assert.equal(r.reason, 'stop')
  assert.equal(r.finishReason, 'content-filter')
})

test('loop（直接喂 Chunk）：tool-call 之前的文本不会和之后的文本混成一块', async () => {
  const model = chunkModel([[
    { type: 'text-delta', text: 'A' },
    { type: 'tool-call', callId: '1', name: 'echo', input: {} },
    { type: 'text-delta', text: 'B' },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } },
  ], [{ type: 'text-delta', text: 'ok' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }]])
  const [, r] = await drain(streamingLoop({ ...base, model }))
  const first = r.messages[1] as Extract<Message, { role: 'assistant' }>
  assert.deepEqual(first.content.map(p => p.type), ['text', 'tool-call', 'text'])
})
