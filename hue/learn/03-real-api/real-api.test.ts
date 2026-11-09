import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Tool } from '../01-minimal-loop/loop.js'
import { reply, redactedBlock, textBlock, thinkingBlock, toolBlock } from '../02-streaming/fixtures.js'
import { drain, streamingLoop } from '../02-streaming/loop.js'
import type { Chunk, Message, ModelRequest } from '../02-streaming/types.js'
import { anthropicModel } from './client.js'
import { classifyHttpError, parseRetryAfter, sleep } from './http.js'
import { errorResponse, fakeFetch, sseResponse, type Step } from './http-fixtures.js'
import { toAnthropicBody } from './request.js'

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => { const out: T[] = []; for await (const x of it) out.push(x); return out }
const req = (messages: Message[] = [{ role: 'user', content: 'hi' }], extra: Partial<ModelRequest> = {}): ModelRequest => ({ system: '', messages, tools: [], ...extra })
const ok = () => sseResponse(reply([textBlock(0, 'ok')], 'end_turn', 1))
const echo: Tool = { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, async execute(i) { return `echo:${JSON.stringify(i)}` } }

/** 构造一个用假 fetch 的模型；睡眠记录下来而不是真的等。 */
function modelWith(steps: Step[], extra: Partial<Parameters<typeof anthropicModel>[0]> = {}) {
  const f = fakeFetch(steps)
  const sleeps: number[] = []
  const model = anthropicModel({ apiKey: 'k-test', model: 'claude-test', fetch: f.fetch, sleep: async ms => { sleeps.push(ms) }, random: () => 1, ...extra })
  return { model, calls: f.calls, sleeps }
}
const signal = () => new AbortController().signal

// ═════════ 第一层：请求体 ═════════

test('请求体：四种消息各自转成 API 格式', () => {
  const body = toAnthropicBody(req([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: '想', providerMetadata: { anthropic: { signature: 'SIG' } } },
      { type: 'reasoning', text: '', providerMetadata: { anthropic: { redactedData: 'ENC' } } },
      { type: 'text', text: '我来查' },
      { type: 'tool-call', callId: 't1', name: 'echo', input: { a: 1 } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', callId: 't1', name: 'echo', text: 'boom', isError: true }] },
  ]), { model: 'm' })
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '想', signature: 'SIG' },
      { type: 'redacted_thinking', data: 'ENC' },
      { type: 'text', text: '我来查' },
      { type: 'tool_use', id: 't1', name: 'echo', input: { a: 1 } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
  ])
})

test('请求体：没有签名的推理、别家的推理、空文本被丢掉；成功的工具结果不带 is_error', () => {
  const body = toAnthropicBody(req([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      { type: 'reasoning', text: '没收完' },
      { type: 'reasoning', text: 'x', providerMetadata: { openai: { id: 'rs_1' } } },
      { type: 'text', text: '' },
      { type: 'tool-call', callId: 't1', name: 'echo', input: {} },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', callId: 't1', name: 'echo', text: 'fine', isError: false }] },
  ]), { model: 'm' })
  const [, assistant, tool] = body.messages as any[]
  assert.deepEqual(assistant.content.map((b: any) => b.type), ['tool_use'])
  assert.deepEqual(tool.content[0], { type: 'tool_result', tool_use_id: 't1', content: 'fine' })
})

test('请求体：字段、默认值、thinking / effort；绝不出现已被移除的采样参数', () => {
  const body = toAnthropicBody(
    req([{ role: 'user', content: 'hi' }], { system: 'SYS', tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }] }),
    { model: 'claude-x', thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' },
  )
  assert.equal(body.model, 'claude-x'); assert.equal(body.max_tokens, 16_000); assert.equal(body.stream, true); assert.equal(body.system, 'SYS')
  assert.deepEqual(body.tools, [{ name: 'echo', description: 'd', input_schema: { type: 'object' } }])
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(body.output_config, { effort: 'high' })
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body), `${k} must not be sent`)
  const bare = toAnthropicBody(req(), { model: 'm', maxTokens: 99, extraBody: { metadata: { user_id: 'u' } } })
  assert.equal(bare.max_tokens, 99); assert.ok(!('system' in bare) && !('tools' in bare) && !('thinking' in bare)); assert.deepEqual(bare.metadata, { user_id: 'u' })
})

test('请求体：最后一条是 assistant（预填）→ 本地直接报错', () => {
  assert.throws(() => toAnthropicBody(req([{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }]), { model: 'm' }), /must end with a user or tool message/)
})

// ═════════ 第二层：HTTP 错误分类 ═════════

test('分类：认证、请求错误、请求过大不重试；限流、过载、5xx 重试', () => {
  const c = (status: number, type: string) => classifyHttpError(status, JSON.stringify({ type: 'error', error: { type, message: 'm' }, request_id: 'req_1' }), new Headers())
  for (const [s, t] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'], [403, 'permission_error'], [404, 'not_found_error'], [413, 'request_too_large']] as const)
    assert.equal(c(s, t).retryable, false, `${s}`)
  for (const [s, t] of [[429, 'rate_limit_error'], [500, 'api_error'], [504, 'timeout_error'], [529, 'overloaded_error']] as const)
    assert.equal(c(s, t).retryable, true, `${s}`)
  const e = c(401, 'authentication_error')
  assert.equal(e.requestId, 'req_1'); assert.equal(e.type, 'authentication_error'); assert.match(e.message, /HTTP 401 authentication_error: m \(request_id req_1\)/)
})

test('分类：400 且文案是超窗 → context_overflow，不可重试', () => {
  const e = classifyHttpError(400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }), new Headers())
  assert.equal(e.code, 'context_overflow'); assert.equal(e.retryable, false)
  assert.equal(classifyHttpError(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad field' } }), new Headers()).code, 'model_error')
})

test('分类：网关返回的不是 JSON（HTML）也不崩，request-id 取自响应头', () => {
  const e = classifyHttpError(502, '<html><body>Bad Gateway</body></html>', new Headers({ 'request-id': 'req_hdr' }))
  assert.equal(e.retryable, true); assert.equal(e.requestId, 'req_hdr'); assert.match(e.message, /Bad Gateway/)
})

test('retry-after：秒数和 HTTP 日期两种写法', () => {
  assert.equal(parseRetryAfter('2'), 2000); assert.equal(parseRetryAfter('0.5'), 500)
  const now = () => Date.parse('Wed, 21 Oct 2026 07:27:58 GMT')
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now), 2000)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:20:00 GMT', now), 0) // 已过去的日期不会变成负数
  assert.equal(parseRetryAfter('soon'), undefined); assert.equal(parseRetryAfter(null), undefined)
})

test('sleep：被取消时立刻 reject，不睡完', async () => {
  const ac = new AbortController(); const t0 = Date.now(); setTimeout(() => ac.abort(), 10)
  await assert.rejects(sleep(10_000, ac.signal), (e: any) => e?.name === 'AbortError')
  assert.ok(Date.now() - t0 < 2000)
  await assert.rejects(sleep(10, AbortSignal.abort()), (e: any) => e?.name === 'AbortError') // 一开始就已取消
})

// ═════════ 第三层：client（假 fetch，整条链路）═════════

test('client：请求的 URL、头、体', async () => {
  const { model, calls } = modelWith([ok()], { baseURL: 'https://relay.example.com/', anthropicVersion: '2023-06-01' })
  await collect(model.stream(req(), signal()))
  const h = calls[0]!.init.headers as Record<string, string>
  assert.equal(calls[0]!.url, 'https://relay.example.com/v1/messages') // 末尾的 / 不会变成 //
  assert.equal(calls[0]!.init.method, 'POST')
  assert.equal(h['x-api-key'], 'k-test'); assert.equal(h['anthropic-version'], '2023-06-01'); assert.equal(h['content-type'], 'application/json')
  assert.equal(calls[0]!.body.model, 'claude-test'); assert.equal(calls[0]!.body.stream, true)
})

test('client：baseURL 带不带 /v1 都拼出同一个地址', async () => {
  for (const base of ['https://relay.example.com/v1', 'https://relay.example.com/v1/', 'https://relay.example.com']) {
    const { model, calls } = modelWith([ok()], { baseURL: base })
    await collect(model.stream(req(), signal()))
    assert.equal(calls[0]!.url, 'https://relay.example.com/v1/messages', base)
  }
})

test('client：默认 API 版本和默认域名', async () => {
  const { model, calls } = modelWith([ok()])
  await collect(model.stream(req(), signal()))
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages')
  assert.equal((calls[0]!.init.headers as Record<string, string>)['anthropic-version'], '2026-10-21')
})

test('client：成功路径产出的 chunk 和第 2 课一致（文本 + finish）', async () => {
  const { model } = modelWith([sseResponse(reply([textBlock(0, '你好，世界')], 'end_turn', 7), { packetSize: 5 })])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join(''), '你好，世界')
  assert.equal(chunks.at(-1)!.type, 'finish')
})

test('重试：529 两次后成功，等待时间按指数退避，请求共 3 次', async () => {
  const { model, calls, sleeps } = modelWith([errorResponse(529, { type: 'overloaded_error', message: 'Overloaded' }), errorResponse(529, { type: 'overloaded_error', message: 'Overloaded' }), ok()])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 3); assert.deepEqual(sleeps, [500, 1000]); assert.equal(chunks.at(-1)!.type, 'finish')
})

test('重试：服务端给了 retry-after 就按它等', async () => {
  const { model, sleeps } = modelWith([errorResponse(429, { type: 'rate_limit_error', message: 'slow down' }, { 'retry-after': '2' }), ok()])
  await collect(model.stream(req(), signal()))
  assert.deepEqual(sleeps, [2000])
})

test('重试：retry-after 比上限还久（比如额度用完）→ 不等，直接报错', async () => {
  const { model, calls, sleeps } = modelWith([errorResponse(429, { type: 'rate_limit_error', message: 'cap' }, { 'retry-after': '600' })])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 1); assert.equal(sleeps.length, 0)
  const err = chunks.at(-1) as Extract<Chunk, { type: 'error' }>
  assert.equal(err.type, 'error'); assert.match(err.message, /429 rate_limit_error/)
})

test('重试：401 不重试，只发一次请求，error 块带原因', async () => {
  const { model, calls } = modelWith([errorResponse(401, { type: 'authentication_error', message: 'invalid x-api-key' })])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 1); assert.equal(chunks.length, 1)
  assert.deepEqual({ ...chunks[0] as object, message: undefined }, { type: 'error', message: undefined, code: 'model_error', retryable: false })
  assert.match((chunks[0] as { message: string }).message, /invalid x-api-key/)
})

test('重试：用完次数后放弃，error 块仍标 retryable（上层可以决定稍后再试）', async () => {
  const { model, calls } = modelWith([errorResponse(529, { type: 'overloaded_error', message: 'o' }), errorResponse(529, { type: 'overloaded_error', message: 'o' }), errorResponse(529, { type: 'overloaded_error', message: 'o' })])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 3) // 1 次 + 2 次重试
  assert.equal((chunks[0] as { retryable?: boolean }).retryable, true)
})

test('重试：maxRetries: 0 就一次都不重试', async () => {
  const { model, calls } = modelWith([errorResponse(529, { type: 'overloaded_error', message: 'o' })], { maxRetries: 0 })
  await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 1)
})

test('重试：网络层失败（fetch 抛 TypeError）也重试', async () => {
  const { model, calls } = modelWith([new TypeError('fetch failed'), ok()])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 2); assert.equal(chunks.at(-1)!.type, 'finish')
})

test('重试：网络一直不通 → error 块，不抛异常', async () => {
  const { model } = modelWith([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')])
  const chunks = await collect(model.stream(req(), signal()))
  assert.match((chunks[0] as { message: string }).message, /network error: fetch failed/)
})

test('超窗：400 prompt is too long → error 块 code = context_overflow', async () => {
  const { model, calls } = modelWith([errorResponse(400, { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' })])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 1)
  assert.equal((chunks[0] as { code?: string }).code, 'context_overflow')
})

test('流中途的 error 事件不重试：delta 已经交给消费者，重试会让文本重复', async () => {
  const events = [...reply([textBlock(0, 'partial')], 'end_turn', 1).slice(0, 4), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]
  const { model, calls } = modelWith([sseResponse(events)])
  const chunks = await collect(model.stream(req(), signal()))
  assert.equal(calls.length, 1)
  assert.ok(chunks.some(c => c.type === 'text-delta'))
  const err = chunks.at(-1) as Extract<Chunk, { type: 'error' }>
  assert.equal(err.type, 'error'); assert.equal(err.retryable, true)
})

test('本地校验失败（最后一条是 assistant）→ error 块，一次请求都不发', async () => {
  const { model, calls } = modelWith([])
  const chunks = await collect(model.stream(req([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }]), signal()))
  assert.equal(calls.length, 0); assert.match((chunks[0] as { message: string }).message, /invalid request/)
})

test('取消：退避等待期间取消 → 抛 AbortError，不再发请求', async () => {
  const ac = new AbortController()
  const f = fakeFetch([errorResponse(529, { type: 'overloaded_error', message: 'o' }), ok()])
  // 不注入 sleep：用真正的、可取消的 sleep，等待 500ms 的过程中取消
  const model = anthropicModel({ apiKey: 'k', model: 'm', fetch: f.fetch, random: () => 1 })
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(collect(model.stream(req(), ac.signal)), (e: any) => e?.name === 'AbortError')
  assert.equal(f.calls.length, 1)
})

test('取消：fetch 阶段被取消 → 原样抛出，不当成"网络错误"重试', async () => {
  const ac = new AbortController(); ac.abort()
  const f = fakeFetch([(init) => { init.signal?.throwIfAborted(); return ok() }])
  const model = anthropicModel({ apiKey: 'k', model: 'm', fetch: f.fetch, sleep: async () => {}, random: () => 1 })
  await assert.rejects(collect(model.stream(req(), ac.signal)), (e: any) => e?.name === 'AbortError')
  assert.equal(f.calls.length, 1)
})

test('取消：流式过程中取消 → loop 以 aborted 结束', async () => {
  const ac = new AbortController()
  const f = fakeFetch([(init) => sseResponse(reply([textBlock(0, '一段很长很长很长的回复内容', 2)], 'end_turn', 20), { packetSize: 6, signal: init.signal ?? undefined })])
  const model = anthropicModel({ apiKey: 'k', model: 'm', fetch: f.fetch })
  const gen = streamingLoop({ model, system: '', tools: [], prompt: 'hi', signal: ac.signal })
  let n = 0, result
  while (true) { const x = await gen.next(); if (x.done) { result = x.value; break } if (x.value.type === 'text-delta' && ++n === 3) ac.abort() }
  assert.equal(result.reason, 'aborted'); assert.equal(f.calls.length, 1)
})

test('释放连接：消费者提前停止时，底层响应流被 cancel', async () => {
  let cancelled = false
  const { model } = modelWith([sseResponse(reply([textBlock(0, '很长的回复很长的回复很长的回复', 2)], 'end_turn', 5), { packetSize: 8, onCancel: () => { cancelled = true } })])
  const it = model.stream(req(), signal())[Symbol.asyncIterator]()
  await it.next() // 只读第一个 chunk
  assert.equal(cancelled, false)
  await it.return?.(undefined)
  assert.equal(cancelled, true)
})

// ═════════ 端到端：loop + client + 假 fetch ═════════

test('端到端：thinking 的签名随第 2 次请求原样发回', async () => {
  const f = fakeFetch([
    sseResponse(reply([thinkingBlock(0, '需要查一下', 'SIG_9'), textBlock(1, '我来查。'), toolBlock(2, 'toolu_1', 'echo', { q: '天气' })], 'tool_use', 40)),
    sseResponse(reply([textBlock(0, '查到了。')], 'end_turn', 8)),
  ])
  const model = anthropicModel({ apiKey: 'k', model: 'm', fetch: f.fetch, thinking: { type: 'adaptive', display: 'summarized' } })
  const [, r] = await drain(streamingLoop({ model, system: 'SYS', tools: [echo], prompt: '天气？' }))
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 2)
  assert.deepEqual(f.calls[0]!.body.messages, [{ role: 'user', content: [{ type: 'text', text: '天气？' }] }])
  assert.deepEqual(f.calls[1]!.body.messages, [
    { role: 'user', content: [{ type: 'text', text: '天气？' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '需要查一下', signature: 'SIG_9' },
      { type: 'text', text: '我来查。' },
      { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { q: '天气' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'echo:{"q":"天气"}' }] },
  ])
})

test('端到端：redacted_thinking 也原样往返（第 2 课修复的缺陷）', async () => {
  const f = fakeFetch([
    sseResponse(reply([redactedBlock(0, 'ENCRYPTED_DATA'), toolBlock(1, 't1', 'echo', {})], 'tool_use', 10)),
    sseResponse(reply([textBlock(0, 'ok')], 'end_turn', 1)),
  ])
  const model = anthropicModel({ apiKey: 'k', model: 'm', fetch: f.fetch })
  await drain(streamingLoop({ model, system: '', tools: [echo], prompt: 'go' }))
  const assistant = f.calls[1]!.body.messages[1]
  assert.deepEqual(assistant.content[0], { type: 'redacted_thinking', data: 'ENCRYPTED_DATA' })
})

test('端到端：HTTP 401 → loop 以 error 结束，历史里只有用户那一条', async () => {
  const f = fakeFetch([errorResponse(401, { type: 'authentication_error', message: 'invalid x-api-key' })])
  const model = anthropicModel({ apiKey: 'bad', model: 'm', fetch: f.fetch })
  const [, r] = await drain(streamingLoop({ model, system: '', tools: [], prompt: 'hi' }))
  assert.equal(r.reason, 'error'); assert.match(r.error!, /401 authentication_error/); assert.equal(r.messages.length, 1)
})

test('端到端：529 重试成功对 loop 完全透明', async () => {
  const f = fakeFetch([errorResponse(529, { type: 'overloaded_error', message: 'o' }), ok()])
  const model = anthropicModel({ apiKey: 'k', model: 'm', fetch: f.fetch, sleep: async () => {}, random: () => 1 })
  const [, r] = await drain(streamingLoop({ model, system: '', tools: [], prompt: 'hi' }))
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 1); assert.equal(f.calls.length, 2)
})

// ═════════ 真实 API（有 key 才跑）═════════

// 优先读网关变量（hue/.env.local），回退到 Anthropic 官方变量名。加载：node --env-file=.env.local ...
const key = process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY
test('真实 API：文本回复 + 工具往返 + 第 2 次请求被接受', { skip: key ? false : 'no AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY' }, async () => {
  const model = anthropicModel({
    apiKey: key!, baseURL: process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL, model: process.env.HUE_LIVE_MODEL ?? 'claude-haiku-5-5',
    maxTokens: 4000, thinking: { type: 'adaptive', display: 'summarized' },
  })
  const [, r] = await drain(streamingLoop({ model, system: 'Use the echo tool once with {"word":"hue"}, then say done.', tools: [echo], prompt: 'go', maxSteps: 4 }))
  assert.equal(r.reason, 'stop', r.error)
  assert.ok(r.steps >= 2, 'expected a tool round trip')
})
