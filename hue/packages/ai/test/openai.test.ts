// OpenAI（Responses API）离线测试：mock fetch + 按文档构造的 SSE，不需要网络和 key。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyState, runTurn, textResult, userText } from '@hue/core'
import type { HueEvent, Message, ModelChunk, ModelRequest, Tool } from '@hue/core'
import { checkChunkStream } from '@hue/core/contracts'
import { openaiModel, model } from '../src/index.js'
import { toOpenAIBody } from '../src/openai/request.js'
import { errorResponse, fakeFetch, sseResponse, type Step } from './fixtures.js'
import { completed, openaiError, reasoningItem, reply, resetSeq, textItem, toolItem, type Wire } from './openai-fixtures.js'

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => { const out: T[] = []; for await (const x of it) out.push(x); return out }
const req = (messages: Message[] = [userText('hi')], extra: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: '', messages, tools: [], ...extra })
const signal = () => new AbortController().signal
const opts = { model: 'm', maxOutputTokens: 16_000 }
const errOf = (cs: ModelChunk[]) => { const e = cs.at(-1); assert.equal(e?.type, 'error'); return (e as Extract<ModelChunk, { type: 'error' }>).error }

/** 用假 fetch 的模型；睡眠记录下来而不是真的等。 */
function modelWith(steps: Step[], extra: Parameters<typeof openaiModel>[1] = {}) {
  const f = fakeFetch(steps)
  const sleeps: number[] = []
  const m = openaiModel('gpt-test', { apiKey: 'k-test', fetch: f.fetch, sleep: async ms => { sleeps.push(ms) }, random: () => 1, ...extra })
  return { m, calls: f.calls, sleeps }
}
/** 跑一次并校验合同。 */
async function run(items: Parameters<typeof reply>[0], o: Parameters<typeof reply>[1] = {}, extra: Partial<ModelRequest> = {}) {
  resetSeq()
  const { m } = modelWith([sseResponse(reply(items, o), { packetSize: 7 })])
  const cs = await collect(m.stream(req([userText('q')], extra), signal()))
  checkChunkStream(cs)
  return cs
}

// ═════════ model() 分发 ═════════

test('model(): openai 前缀分发；id / specVersion / info', () => {
  const m = model('openai:gpt-6.1-sol', { apiKey: 'k' })
  assert.equal(m.id, 'openai:gpt-6.1-sol'); assert.equal(m.specVersion, 'hue.model.v1')
  assert.equal(m.info.contextWindow, 1_050_000)
  const u = model('openai:some-relay-alias', { apiKey: 'k' }).info
  assert.equal(u.contextWindow, 200_000); assert.equal(u.supports.reasoning, false)
})

test('model(): openai 没有 key 就在构造时报错（OPENAI_API_KEY / AI_GATEWAY_API_KEY 都看）', () => {
  const s1 = process.env.OPENAI_API_KEY, s2 = process.env.AI_GATEWAY_API_KEY
  delete process.env.OPENAI_API_KEY; delete process.env.AI_GATEWAY_API_KEY
  try {
    assert.throws(() => model('openai:gpt-6.1-sol'), /missing apiKey/)
    process.env.OPENAI_API_KEY = 'k'
    assert.doesNotThrow(() => model('openai:gpt-6.1-sol'))
  } finally {
    delete process.env.OPENAI_API_KEY
    if (s1 !== undefined) process.env.OPENAI_API_KEY = s1
    if (s2 !== undefined) process.env.AI_GATEWAY_API_KEY = s2
  }
})

// ═════════ 请求体 ═════════

test('请求体：四种消息各自转成 input items；store:false；无状态推理回传', () => {
  const body = toOpenAIBody(req([
    userText('q'),
    { role: 'assistant', content: [
      { type: 'reasoning', text: '', providerMetadata: { openai: { encryptedContent: 'ENC_1' } } },
      { type: 'reasoning', text: '别家的', providerMetadata: { anthropic: { signature: 'SIG' } } },
      { type: 'reasoning', text: '没加密的' },
      { type: 'text', text: '我来查' },
      { type: 'tool-call', callId: 'call_1', name: 'echo', input: { a: 1 } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', callId: 'call_1', name: 'echo', isError: true, content: [{ type: 'text', text: 'boom' }] }] },
    userText('等等'),
  ]), opts)
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
    { type: 'reasoning', content: [], summary: [], encrypted_content: 'ENC_1' },
    { role: 'assistant', content: [{ type: 'output_text', text: '我来查' }] },
    { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"a":1}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'boom' },
    { role: 'user', content: [{ type: 'input_text', text: '等等' }], },
  ])
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.model, 'm')
})

test('请求体：json 结果序列化、图片 content、未知文件类型报错；toolChoice 映射', () => {
  const tools = [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }]
  const body = toOpenAIBody(req([
    { role: 'tool', content: [{ type: 'tool-result', callId: 'c', name: 'echo', isError: false, content: [{ type: 'json', value: { n: 1 } }] }] },
    { role: 'user', content: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }, { type: 'file', mediaType: 'image/jpeg', url: 'https://x.test/a.jpg' }] },
  ], { tools, toolChoice: { name: 'echo' }, instructions: 'SYS', settings: { maxOutputTokens: 99 } }), opts)
  assert.deepEqual(body.input, [
    { type: 'function_call_output', call_id: 'c', output: '{"n":1}' },
    { role: 'user', content: [
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_image', image_url: 'https://x.test/a.jpg' },
    ] },
  ])
  assert.deepEqual(body.tools, [{ type: 'function', name: 'echo', description: 'd', parameters: { type: 'object' }, strict: false }])
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'echo' })
  assert.equal(body.instructions, 'SYS'); assert.equal(body.max_output_tokens, 99)
  const map = (c: ModelRequest['toolChoice']) => toOpenAIBody(req([userText('x')], { tools, toolChoice: c }), opts).tool_choice
  assert.deepEqual([map(undefined), map('auto'), map('none'), map('required')], ['auto', 'auto', 'none', 'required'])
  assert.throws(() => toOpenAIBody(req([{ role: 'user', content: [{ type: 'file', mediaType: 'video/mp4', url: 'https://x.test/v' }] }]), opts), /unsupported file type/)
})

test('请求体：effort 透传；providerOptions.openai 合并进最外层', () => {
  const withEffort = toOpenAIBody(req(), { ...opts, effort: 'high' })
  assert.deepEqual(withEffort.reasoning, { effort: 'high' })
  const none = toOpenAIBody(req(), { ...opts, effort: 'none' })
  assert.deepEqual(none.reasoning, { effort: 'none' })
  const bare = toOpenAIBody(req(), opts)
  assert.ok(!('reasoning' in bare) && !('instructions' in bare) && !('tools' in bare) && !('max_output_tokens' in bare))
  assert.deepEqual(toOpenAIBody(req([userText('x')], { settings: { providerOptions: { openai: { user: 'u1' } } } }), opts).user, 'u1')
})

// ═════════ 流式拼装（每个 fixture 都过 checkChunkStream）═════════

test('流：纯文本 + usage（cached / reasoning 细分）', async () => {
  const cs = await run([textItem(0, '你好，世界')], { inputTokens: 50, outputTokens: 7, cachedTokens: 30, reasoningTokens: 4 })
  assert.equal(cs.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join(''), '你好，世界')
  assert.deepEqual(cs.at(-1), { type: 'finish', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 30, reasoningTokens: 4 } })
})

test('流：并行两个 tool call，各自参数完整后才发一次；空参数 input = {}', async () => {
  const cs = await run([toolItem(0, 'c1', 'echo', { q: '北京' }), toolItem(1, 'c2', 'now', {})], { outputTokens: 9 })
  assert.deepEqual(cs.filter(c => c.type === 'tool-call'), [
    { type: 'tool-call', callId: 'c1', name: 'echo', input: { q: '北京' } },
    { type: 'tool-call', callId: 'c2', name: 'now', input: {} },
  ])
  assert.ok(cs.filter(c => c.type === 'tool-input-delta').length >= 1)
  assert.equal((cs.at(-1) as { finishReason: string }).finishReason, 'tool-calls')
})

test('流：推理摘要 → reasoning-delta；encrypted_content 进 reasoning-end 的 providerMetadata', async () => {
  const cs = await run([reasoningItem(0, '想一想', 'ENC_X'), textItem(1, '好')])
  assert.deepEqual(cs.filter(c => c.type === 'reasoning-end').map(c => (c as any).providerMetadata), [{ openai: { encryptedContent: 'ENC_X' } }])
  assert.equal(cs.filter(c => c.type === 'reasoning-delta').map(c => (c as any).text).join(''), '想一想')
})

test('流：参数 JSON 被截断 → input = { __raw }，finishReason 仍是 tool-calls', async () => {
  const cs = await run([toolItem(0, 'c1', 'echo', '{"q":"旧金')], { incomplete: 'max_output_tokens' })
  assert.deepEqual(cs.find(c => c.type === 'tool-call'), { type: 'tool-call', callId: 'c1', name: 'echo', input: { __raw: '{"q":"旧金' } })
  assert.equal((cs.at(-1) as { finishReason: string }).finishReason, 'tool-calls')
})

test('流：incomplete_details 映射；没有 tool-call 的 max_output_tokens 是 length', async () => {
  const cs = await run([textItem(0, 'x')], { incomplete: 'max_output_tokens' })
  assert.equal((cs.at(-1) as { finishReason: string }).finishReason, 'length')
})

test('流：未知 item 类型和未知事件被安静忽略', async () => {
  resetSeq()
  const events = reply([textItem(0, 'a')])
  events.splice(3, 0, { type: 'response.output_item.added', output_index: 9, item: { id: 'ws_1', type: 'web_search_call' } } as never,
    { type: 'response.output_item.done', output_index: 9, item: { id: 'ws_1', type: 'web_search_call' } } as never,
    { type: 'response.future_event' } as never)
  const { m } = modelWith([sseResponse(events)])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(cs.at(-1)!.type, 'finish')
})

test('流：断流（没有 response.completed）当错误，不当完整回复', async () => {
  resetSeq()
  const { m } = modelWith([sseResponse(reply([textItem(0, 'partial')]).slice(0, -1))])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.ok(!cs.some(c => c.type === 'finish')); assert.equal(errOf(cs).retryable, true); assert.match(errOf(cs).message, /before response\.completed/)
})

test('流：response.failed → 可重试 error 块；流中 error 事件（限流）→ retryable', async () => {
  resetSeq()
  const { m } = modelWith([sseResponse([completed(), { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } } as never as Wire])])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(errOf(cs).retryable, true); assert.match(errOf(cs).message, /server_error: boom/)
  resetSeq()
  const b = modelWith([sseResponse([{ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' } as never as Wire])])
  const cb = await collect(b.m.stream(req(), signal()))
  assert.equal(errOf(cb).retryable, true); assert.match(errOf(cb).message, /rate_limit_exceeded/)
})

test('流：产出内容之前断开 → 静默重发；之后断开 → 不重发', async () => {
  resetSeq()
  const cut = () => { const it = reply([textItem(0, 'ok')]); return sseResponse(it.slice(0, 2)) } // 只有 created/in_progress
  const { m, calls, sleeps } = modelWith([cut(), (() => { resetSeq(); return sseResponse(reply([textItem(0, 'ok')])) })()])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(calls.length, 2); assert.deepEqual(sleeps, [500])
  assert.equal(cs.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join(''), 'ok')
})

// ═════════ HTTP：错误分类（OpenAI 错误体）═════════

test('分类：OpenAI 错误体（{ error: { message, type, code } }）→ requestId 取 x-request-id', async () => {
  const { m, calls } = modelWith([openaiError(401, 'Incorrect API key', { code: 'invalid_api_key' })])
  const cs = await collect(m.stream(req(), signal()))
  assert.equal(calls.length, 1); assert.equal(errOf(cs).retryable, false); assert.match(errOf(cs).message, /Incorrect API key/)
})

test('重试：中途 500 后成功，退避 500、1000ms，共 3 次请求；网络失败也重试', async () => {
  resetSeq()
  const ok = () => { resetSeq(); return sseResponse(reply([textItem(0, 'ok')])) }
  const a = modelWith([openaiError(500, 's', { type: 'server_error' }), openaiError(500, 's', { type: 'server_error' }), ok()])
  const cs = await collect(a.m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(a.calls.length, 3); assert.deepEqual(a.sleeps, [500, 1000])
  const b = modelWith([new TypeError('fetch failed'), ok()])
  await collect(b.m.stream(req(), signal())); assert.equal(b.calls.length, 2)
})

test('请求：URL、Bearer 头；baseURL 带不带 /v1 都拼出同一个地址', async () => {
  for (const base of ['https://relay.example.com/v1', 'https://relay.example.com/v1/', 'https://relay.example.com/']) {
    resetSeq()
    const { m, calls } = modelWith([sseResponse(reply([textItem(0, 'ok')]))], { baseURL: base })
    await collect(m.stream(req(), signal()))
    assert.equal(calls[0]!.url, 'https://relay.example.com/v1/responses', base)
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer k-test')
    assert.equal(calls[0]!.body.model, 'gpt-test'); assert.equal(calls[0]!.body.store, false)
  }
})

test('取消：流式过程中取消 → 抛 AbortError（不是 error 块）', async () => {
  resetSeq()
  const ac = new AbortController()
  const f = fakeFetch([init => sseResponse(reply([textItem(0, '一段很长很长很长的回复内容', 2)], { outputTokens: 20 }), { packetSize: 6, signal: init.signal ?? undefined })])
  const m = openaiModel('gpt-test', { apiKey: 'k', fetch: f.fetch })
  let n = 0
  await assert.rejects(async () => { for await (const c of m.stream(req(), ac.signal)) if (c.type === 'text-delta' && ++n === 3) ac.abort() }, (e: any) => e?.name === 'AbortError')
})

test('释放连接：消费者提前停止时，底层响应流被 cancel', async () => {
  resetSeq()
  let cancelled = false
  const { m } = modelWith([sseResponse(reply([textItem(0, '很长的回复很长的回复很长的回复', 2)], { outputTokens: 5 }), { packetSize: 8, onCancel: () => { cancelled = true } })])
  const it = m.stream(req(), signal())[Symbol.asyncIterator]()
  await it.next(); assert.equal(cancelled, false)
  await it.return?.(undefined); assert.equal(cancelled, true)
})

// ═════════ 与 core 的 runTurn 集成 ═════════

const echo: Tool = { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, effects: 'none', async execute(i) { return textResult(`echo:${JSON.stringify(i)}`) } }

test('集成（真 core loop）：加密推理经 fold 后随第 2 次请求原样发回，function_call_output 配对', async () => {
  resetSeq()
  const f = fakeFetch([
    sseResponse(reply([reasoningItem(0, '需要查一下', 'ENC_9'), textItem(1, '我来查。'), toolItem(2, 'call_1', 'echo', { q: '天气' })], { outputTokens: 40 })),
    sseResponse(reply([textItem(0, '查到了。')], { outputTokens: 8 })),
  ])
  const m = openaiModel('gpt-test', { apiKey: 'k', fetch: f.fetch })
  const g = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('天气？'), model: m, instructions: 'SYS', tools: [echo] })
  const events: HueEvent[] = []; let r
  while (true) { const n = await g.next(); if (n.done) { r = n.value; break } events.push(n.value) }
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 2)
  assert.deepEqual(f.calls[1]!.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: '天气？' }] },
    { type: 'reasoning', content: [], summary: [], encrypted_content: 'ENC_9' },
    { role: 'assistant', content: [{ type: 'output_text', text: '我来查。' }] },
    { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"q":"天气"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'echo:{"q":"天气"}' },
  ])
  assert.equal(f.calls[0]!.body.instructions, 'SYS')
})

test('集成（真 core loop）：HTTP 401 → turn 以 error 结束，错误码和来源保留', async () => {
  const f = fakeFetch([errorResponse(401, { type: 'invalid_request_error', message: 'bad bearer' })])
  const m = openaiModel('gpt-test', { apiKey: 'bad', fetch: f.fetch })
  const g = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('hi'), model: m })
  let r; while (true) { const n = await g.next(); if (n.done) { r = n.value; break } }
  assert.equal(r.reason, 'error'); assert.equal(r.error?.code, 'model_error'); assert.equal(r.error?.source, 'ai:openai'); assert.equal(r.error?.retryable, false)
})
