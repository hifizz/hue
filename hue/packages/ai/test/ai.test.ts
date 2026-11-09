import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyState, runTurn, textResult, userText } from '@hue/core'
import type { HueEvent, Message, ModelChunk, ModelRequest, Tool } from '@hue/core'
import { checkChunkStream } from '@hue/core/contracts'
import { anthropicModel, model } from '../src/index.js'
import { classifyHttpError, parseRetryAfter, sleep } from '../src/http.js'
import { toAnthropicBody } from '../src/request.js'
import { errorResponse, fakeFetch, reply, redactedBlock, sseResponse, textBlock, thinkingBlock, toolBlock, type Step } from './fixtures.js'

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => { const out: T[] = []; for await (const x of it) out.push(x); return out }
const req = (messages: Message[] = [userText('hi')], extra: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: '', messages, tools: [], ...extra })
const signal = () => new AbortController().signal
const ok = () => sseResponse(reply([textBlock(0, 'ok')], 'end_turn', 1))
const opts = { model: 'm', maxTokens: 16_000 }
const errOf = (cs: ModelChunk[]) => { const e = cs.at(-1); assert.equal(e?.type, 'error'); return (e as Extract<ModelChunk, { type: 'error' }>).error }

/** 用假 fetch 的模型；睡眠记录下来而不是真的等。 */
function modelWith(steps: Step[], extra: Parameters<typeof anthropicModel>[1] = {}) {
  const f = fakeFetch(steps)
  const sleeps: number[] = []
  const m = anthropicModel('claude-test', { apiKey: 'k-test', fetch: f.fetch, sleep: async ms => { sleeps.push(ms) }, random: () => 1, ...extra })
  return { m, calls: f.calls, sleeps }
}
/** 跑一次并校验合同（离线 fixture 每个都要过 checkChunkStream）。 */
async function run(events: Parameters<typeof reply>[0], stop: string, extra: Partial<ModelRequest> = {}) {
  const { m } = modelWith([sseResponse(reply(events, stop, 20), { packetSize: 7 })])
  const cs = await collect(m.stream(req([userText('q')], extra), signal()))
  checkChunkStream(cs)
  return cs
}

// ═════════ model() 分发 ═════════

test('model(): 按前缀分发；未知前缀、缺冒号、openai（未实现）都抛错', () => {
  const m = model('anthropic:claude-haiku-5-5', { apiKey: 'k' })
  assert.equal(m.id, 'anthropic:claude-haiku-5-5'); assert.equal(m.specVersion, 'hue.model.v1')
  assert.throws(() => model('mystery:x', { apiKey: 'k' }), /unknown model provider "mystery"/)
  assert.throws(() => model('claude-haiku-5-5'), /must look like/)
  assert.throws(() => model('openai:gpt-5'), /not implemented/)
})

test('model(): 没有 key 就在构造时报错，不等到第一次请求', () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY
  try { assert.throws(() => model('anthropic:x'), /missing apiKey/) } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved }
})

test('info: 已知模型用官方数字；未知模型给保守默认值', () => {
  assert.equal(model('anthropic:claude-sonnet-5-5', { apiKey: 'k' }).info.contextWindow, 1_000_000)
  const u = model('anthropic:some-relay-alias', { apiKey: 'k' }).info
  assert.equal(u.contextWindow, 200_000); assert.equal(u.supports.reasoning, false)
})

// ═════════ 请求体 ═════════

test('请求体：四种消息各自转成 API 格式', () => {
  const body = toAnthropicBody(req([
    userText('q'),
    { role: 'assistant', content: [
      { type: 'reasoning', text: '想', providerMetadata: { anthropic: { signature: 'SIG' } } },
      { type: 'reasoning', text: '', providerMetadata: { anthropic: { redactedData: 'ENC' } } },
      { type: 'text', text: '我来查' },
      { type: 'tool-call', callId: 't1', name: 'echo', input: { a: 1 } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', callId: 't1', name: 'echo', isError: true, content: [{ type: 'text', text: 'boom' }] }] },
  ]), opts)
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '想', signature: 'SIG' },
      { type: 'redacted_thinking', data: 'ENC' },
      { type: 'text', text: '我来查' },
      { type: 'tool_use', id: 't1', name: 'echo', input: { a: 1 } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'boom' }], is_error: true }] },
  ])
})

test('请求体：别家的推理、没签名的推理、空文本被丢；json 结果序列化成文本；工具结果后的插话合并进同一条 user', () => {
  const body = toAnthropicBody(req([
    userText('q'),
    { role: 'assistant', content: [
      { type: 'reasoning', text: '没收完' },
      { type: 'reasoning', text: 'x', providerMetadata: { openai: { id: 'rs_1' } } },
      { type: 'text', text: '' },
      { type: 'tool-call', callId: 't1', name: 'echo', input: {} },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', callId: 't1', name: 'echo', isError: false, content: [{ type: 'json', value: { n: 1 } }] }] },
    userText('等等'),
  ]), opts)
  const [, assistant, user] = body.messages as any[]
  assert.deepEqual(assistant.content.map((b: any) => b.type), ['tool_use'])
  assert.deepEqual(user.content, [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"n":1}' }] }, // tool_result 必须在前
    { type: 'text', text: '等等' },
  ])
  assert.equal((body.messages as unknown[]).length, 3)
})

test('请求体：data URL 图片变 base64 块，普通 URL 变 url 块，不认识的类型报错', () => {
  const body = toAnthropicBody(req([{ role: 'user', content: [
    { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
    { type: 'file', mediaType: 'image/jpeg', url: 'https://x.test/a.jpg' },
  ] }]), opts)
  assert.deepEqual((body.messages as any[])[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'image', source: { type: 'url', url: 'https://x.test/a.jpg' } },
  ])
  assert.throws(() => toAnthropicBody(req([{ role: 'user', content: [{ type: 'file', mediaType: 'video/mp4', url: 'https://x.test/v' }] }]), opts), /unsupported file type/)
})

test('请求体：字段、toolChoice、thinking / effort；绝不出现已被移除的采样参数', () => {
  const tools = [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }]
  const body = toAnthropicBody(req([userText('hi')], { instructions: 'SYS', tools, toolChoice: { name: 'echo' }, settings: { maxOutputTokens: 77, temperature: 0.2 } }),
    { ...opts, thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' })
  assert.equal(body.max_tokens, 77); assert.equal(body.stream, true)
  assert.deepEqual(body.system, [{ type: 'text', text: 'SYS' }])
  assert.deepEqual(body.tools, [{ name: 'echo', description: 'd', input_schema: { type: 'object' } }])
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'echo' })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' }); assert.deepEqual(body.output_config, { effort: 'high' })
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body), `${k} must not be sent`)
  const map = (c: ModelRequest['toolChoice']) => toAnthropicBody(req([userText('x')], { tools, toolChoice: c }), opts).tool_choice
  assert.deepEqual([map(undefined), map('none'), map('required')], [{ type: 'auto' }, { type: 'none' }, { type: 'any' }])
  const bare = toAnthropicBody(req(), { ...opts, maxTokens: 99 })
  assert.ok(!('system' in bare) && !('tools' in bare) && !('tool_choice' in bare) && !('thinking' in bare)); assert.equal(bare.max_tokens, 99)
})

test('请求体：providerOptions.anthropic 合并进最外层（逃生口）', () => {
  const body = toAnthropicBody(req([userText('x')], { settings: { providerOptions: { anthropic: { metadata: { user_id: 'u' } } } } }), opts)
  assert.deepEqual(body.metadata, { user_id: 'u' })
})

test('请求体：cache 断点只放在 system 末尾、最后一个工具、最后一条消息的最后一块', () => {
  const tools = [{ name: 'a', description: '', inputSchema: {} }, { name: 'b', description: '', inputSchema: {} }]
  const body = toAnthropicBody(req([userText('q1'), { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, userText('q2')], { instructions: 'S', tools }), { ...opts, cache: true })
  const cc = { cache_control: { type: 'ephemeral' } }
  assert.deepEqual((body.system as any[])[0].cache_control, cc.cache_control)
  assert.equal((body.tools as any[])[0].cache_control, undefined); assert.deepEqual((body.tools as any[])[1].cache_control, cc.cache_control)
  const m = body.messages as any[]
  assert.equal(m[0].content[0].cache_control, undefined); assert.deepEqual(m[2].content[0].cache_control, cc.cache_control)
  assert.ok(!JSON.stringify(toAnthropicBody(req([userText('q')], { instructions: 'S', tools }), opts)).includes('cache_control')) // 默认关（构造 model 时才默认开）
})

test('请求体：最后一条是 assistant（预填）→ 本地直接报错', () => {
  assert.throws(() => toAnthropicBody(req([userText('q'), { role: 'assistant', content: [{ type: 'text', text: 'a' }] }]), opts), /must end with a user or tool message/)
})

// ═════════ 流式拼装（每个 fixture 都过 checkChunkStream）═════════

test('流：纯文本 + usage（含 cache、累计值覆盖而非累加）', async () => {
  const events = reply([textBlock(0, '你好，世界')], 'end_turn', 7)
  ;(events[0] as any).message.usage.cache_read_input_tokens = 30; (events[0] as any).message.usage.cache_creation_input_tokens = 5
  const { m } = modelWith([sseResponse(events, { packetSize: 5 })])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(cs.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join(''), '你好，世界') // 中文被切在包边界也不乱码
  assert.deepEqual(cs.at(-1), { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 5 } })
})

test('流：并行两个 tool call，各自参数完整后才发一次', async () => {
  const cs = await run([toolBlock(0, 'c1', 'echo', { q: '北京' }), toolBlock(1, 'c2', 'echo', { q: '上海' })], 'tool_use')
  assert.deepEqual(cs.filter(c => c.type === 'tool-call'), [
    { type: 'tool-call', callId: 'c1', name: 'echo', input: { q: '北京' } },
    { type: 'tool-call', callId: 'c2', name: 'echo', input: { q: '上海' } },
  ])
  assert.ok(cs.filter(c => c.type === 'tool-input-delta').length > 2) // 增量给 UI
  assert.equal((cs.at(-1) as { finishReason: string }).finishReason, 'tool-calls')
})

test('流：无参数工具 input = {}', async () => {
  const cs = await run([toolBlock(0, 'c1', 'now', {})], 'tool_use')
  assert.deepEqual(cs.find(c => c.type === 'tool-call'), { type: 'tool-call', callId: 'c1', name: 'now', input: {} })
})

test('流：推理块的签名和加密数据进 reasoning-end 的 providerMetadata', async () => {
  const cs = await run([thinkingBlock(0, '想一想', 'SIG_1'), redactedBlock(1, 'ENC_1'), textBlock(2, '好')], 'end_turn')
  assert.deepEqual(cs.filter(c => c.type === 'reasoning-end').map(c => (c as any).providerMetadata), [{ anthropic: { signature: 'SIG_1' } }, { anthropic: { redactedData: 'ENC_1' } }])
  assert.equal(cs.filter(c => c.type === 'reasoning-delta').map(c => (c as any).text).join(''), '想一想')
})

test('流：参数 JSON 被截断（max_tokens）→ input = { __raw }，finishReason 仍是 tool-calls', async () => {
  const cs = await run([toolBlock(0, 'c1', 'echo', '{"q":"旧金')], 'max_tokens')
  assert.deepEqual(cs.find(c => c.type === 'tool-call'), { type: 'tool-call', callId: 'c1', name: 'echo', input: { __raw: '{"q":"旧金' } })
})

test('流：stop_reason 映射；没有 tool-call 的 max_tokens 是 length，拒答是 content-filter', async () => {
  for (const [stop, want] of [['max_tokens', 'length'], ['refusal', 'content-filter'], ['stop_sequence', 'stop'], ['pause_turn', 'other']] as const) {
    const cs = await run([textBlock(0, 'x')], stop)
    assert.equal((cs.at(-1) as { finishReason: string }).finishReason, want, stop)
  }
})

test('流：未知块类型和未知事件被安静忽略', async () => {
  const events = reply([textBlock(0, 'a')], 'end_turn', 1)
  events.splice(3, 0, { type: 'content_block_start', index: 9, content_block: { type: 'server_tool_use', id: 'x' } } as never, { type: 'future_event' } as never, { type: 'content_block_stop', index: 9 } as never)
  const { m } = modelWith([sseResponse(events)])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(cs.at(-1)!.type, 'finish')
})

test('流：断流（没有 message_stop）当错误，不当成完整回复', async () => {
  const { m } = modelWith([sseResponse(reply([textBlock(0, 'partial')], 'end_turn', 1).slice(0, -1))])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.ok(!cs.some(c => c.type === 'finish')); assert.equal(errOf(cs).retryable, true); assert.match(errOf(cs).message, /before message_stop/)
})

test('流：中途 error 事件 → error 块（带 source），不重试：delta 已交给消费者，重试会让文本重复', async () => {
  const events = [...reply([textBlock(0, 'partial')], 'end_turn', 1).slice(0, 4), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]
  const { m, calls } = modelWith([sseResponse(events)])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(calls.length, 1); assert.ok(cs.some(c => c.type === 'text-delta'))
  assert.deepEqual(errOf(cs), { code: 'model_error', message: 'overloaded_error: Overloaded', retryable: true, source: 'ai:anthropic' })
})

test('流：读流中途连接被重置 → 可重试的 error 块，而不是异常', async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n')); c.error(new TypeError('terminated')) } })
  const { m } = modelWith([new Response(body, { status: 200 })])
  const cs = await collect(m.stream(req(), signal()))
  assert.match(errOf(cs).message, /stream read failed: terminated/); assert.equal(errOf(cs).retryable, true)
})

// ═════════ HTTP：分类与重试 ═════════

test('分类：认证、请求错误、请求过大不重试；限流、过载、5xx 重试', () => {
  const c = (status: number, type: string) => classifyHttpError(status, JSON.stringify({ type: 'error', error: { type, message: 'm' }, request_id: 'req_1' }), new Headers())
  for (const [s, t] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'], [403, 'permission_error'], [404, 'not_found_error'], [413, 'request_too_large']] as const)
    assert.equal(c(s, t).retryable, false, `${s}`)
  for (const [s, t] of [[429, 'rate_limit_error'], [500, 'api_error'], [504, 'timeout_error'], [529, 'overloaded_error']] as const)
    assert.equal(c(s, t).retryable, true, `${s}`)
  assert.match(c(401, 'authentication_error').message, /HTTP 401 authentication_error: m \(request_id req_1\)/)
})

test('分类：400 且文案是超窗 → context_overflow；网关返回 HTML 也不崩', () => {
  const e = classifyHttpError(400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }), new Headers())
  assert.equal(e.code, 'context_overflow'); assert.equal(e.retryable, false)
  assert.equal(classifyHttpError(400, JSON.stringify({ error: { message: 'bad field' } }), new Headers()).code, 'model_error')
  const h = classifyHttpError(502, '<html>Bad Gateway</html>', new Headers({ 'request-id': 'req_hdr' }))
  assert.equal(h.retryable, true); assert.equal(h.requestId, 'req_hdr')
})

test('retry-after：秒数和 HTTP 日期；sleep 被取消时立刻 reject', async () => {
  assert.equal(parseRetryAfter('2'), 2000)
  const now = () => Date.parse('Wed, 21 Oct 2026 07:27:58 GMT')
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now), 2000); assert.equal(parseRetryAfter('soon'), undefined)
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10)
  await assert.rejects(sleep(10_000, ac.signal), (e: any) => e?.name === 'AbortError')
})

test('重试：中途 5xx（响应开始前）后重试成功，退避 500、1000ms，共 3 次请求', async () => {
  const overloaded = () => errorResponse(529, { type: 'overloaded_error', message: 'Overloaded' })
  const { m, calls, sleeps } = modelWith([overloaded(), overloaded(), ok()])
  const cs = await collect(m.stream(req(), signal())); checkChunkStream(cs)
  assert.equal(calls.length, 3); assert.deepEqual(sleeps, [500, 1000]); assert.equal(cs.at(-1)!.type, 'finish')
})

test('重试：retry-after 优先；比上限还久就不等，直接报错', async () => {
  const a = modelWith([errorResponse(429, { type: 'rate_limit_error', message: 's' }, { 'retry-after': '2' }), ok()])
  await collect(a.m.stream(req(), signal())); assert.deepEqual(a.sleeps, [2000])
  const b = modelWith([errorResponse(429, { type: 'rate_limit_error', message: 'cap' }, { 'retry-after': '600' })])
  const cs = await collect(b.m.stream(req(), signal()))
  assert.equal(b.calls.length, 1); assert.equal(b.sleeps.length, 0); assert.equal(errOf(cs).retryable, true)
})

test('错误映射：401 不重试且 retryable=false；用完次数后放弃仍 retryable=true；maxRetries:0 不重试', async () => {
  const a = modelWith([errorResponse(401, { type: 'authentication_error', message: 'invalid x-api-key' })])
  const ca = await collect(a.m.stream(req(), signal()))
  assert.equal(a.calls.length, 1); assert.equal(ca.length, 1)
  assert.deepEqual({ ...errOf(ca), message: '' }, { code: 'model_error', message: '', retryable: false, source: 'ai:anthropic' }); assert.match(errOf(ca).message, /invalid x-api-key/)
  const o = () => errorResponse(529, { type: 'overloaded_error', message: 'o' })
  const b = modelWith([o(), o(), o()]); const cb = await collect(b.m.stream(req(), signal()))
  assert.equal(b.calls.length, 3); assert.equal(errOf(cb).retryable, true)
  const c = modelWith([o()], { maxRetries: 0 }); await collect(c.m.stream(req(), signal())); assert.equal(c.calls.length, 1)
})

test('错误映射：400 prompt is too long → code = context_overflow（loop 靠它触发压缩重试）', async () => {
  const { m, calls } = modelWith([errorResponse(400, { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' })])
  const cs = await collect(m.stream(req(), signal()))
  assert.equal(calls.length, 1); assert.equal(errOf(cs).code, 'context_overflow'); assert.equal(errOf(cs).retryable, false)
})

test('重试：网络层失败重试；一直不通 → error 块，不抛异常', async () => {
  const a = modelWith([new TypeError('fetch failed'), ok()]); await collect(a.m.stream(req(), signal())); assert.equal(a.calls.length, 2)
  const b = modelWith([new TypeError('x'), new TypeError('x'), new TypeError('fetch failed')])
  assert.match(errOf(await collect(b.m.stream(req(), signal()))).message, /network error: fetch failed/)
})

test('请求：URL、头；baseURL 带不带 /v1 或末尾 / 都拼出同一个地址', async () => {
  for (const base of ['https://relay.example.com/v1', 'https://relay.example.com/v1/', 'https://relay.example.com/']) {
    const { m, calls } = modelWith([ok()], { baseURL: base, anthropicVersion: '2023-06-01' })
    await collect(m.stream(req(), signal()))
    const h = calls[0]!.init.headers as Record<string, string>
    assert.equal(calls[0]!.url, 'https://relay.example.com/v1/messages', base)
    assert.equal(h['x-api-key'], 'k-test'); assert.equal(h['anthropic-version'], '2023-06-01')
    assert.equal(calls[0]!.body.model, 'claude-test'); assert.equal(calls[0]!.body.stream, true)
  }
  // 默认地址：环境里可能设了 ANTHROPIC_BASE_URL（代理），测试不能依赖它
  const saved = process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_BASE_URL
  const d = modelWith([ok()]); await collect(d.m.stream(req(), signal()))
  if (saved !== undefined) process.env.ANTHROPIC_BASE_URL = saved
  assert.equal(d.calls[0]!.url, 'https://api.anthropic.com/v1/messages'); assert.equal((d.calls[0]!.init.headers as Record<string, string>)['anthropic-version'], '2026-10-21')
})

test('请求：默认开 cache 断点；本地校验失败 → error 块且不发请求', async () => {
  const { m, calls } = modelWith([ok()])
  await collect(m.stream(req([userText('q')], { instructions: 'S' }), signal()))
  assert.deepEqual(calls[0]!.body.system[0].cache_control, { type: 'ephemeral' })
  const bad = modelWith([])
  const cs = await collect(bad.m.stream(req([{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }]), signal()))
  assert.equal(bad.calls.length, 0); assert.match(errOf(cs).message, /invalid request/); assert.equal(errOf(cs).retryable, false)
})

// ═════════ 取消 ═════════

test('取消：退避等待期间取消 → AbortError，不再发请求', async () => {
  const ac = new AbortController()
  const f = fakeFetch([errorResponse(529, { type: 'overloaded_error', message: 'o' }), ok()])
  const m = anthropicModel('m', { apiKey: 'k', fetch: f.fetch, random: () => 1 }) // 不注入 sleep：用真正可取消的
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(collect(m.stream(req(), ac.signal)), (e: any) => e?.name === 'AbortError')
  assert.equal(f.calls.length, 1)
})

test('取消：流式过程中取消 → 抛 AbortError（不是 error 块）', async () => {
  const ac = new AbortController()
  const f = fakeFetch([init => sseResponse(reply([textBlock(0, '一段很长很长很长的回复内容', 2)], 'end_turn', 20), { packetSize: 6, signal: init.signal ?? undefined })])
  const m = anthropicModel('m', { apiKey: 'k', fetch: f.fetch })
  let n = 0
  await assert.rejects(async () => { for await (const c of m.stream(req(), ac.signal)) if (c.type === 'text-delta' && ++n === 3) ac.abort() }, (e: any) => e?.name === 'AbortError')
})

test('释放连接：消费者提前停止时，底层响应流被 cancel', async () => {
  let cancelled = false
  const { m } = modelWith([sseResponse(reply([textBlock(0, '很长的回复很长的回复很长的回复', 2)], 'end_turn', 5), { packetSize: 8, onCancel: () => { cancelled = true } })])
  const it = m.stream(req(), signal())[Symbol.asyncIterator]()
  await it.next(); assert.equal(cancelled, false)
  await it.return?.(undefined); assert.equal(cancelled, true)
})

// ═════════ 与 core 的 runTurn 集成 ═════════

const echo: Tool = { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, effects: 'none', async execute(i) { return textResult(`echo:${JSON.stringify(i)}`) } }

test('集成（真 core loop）：thinking 签名经 fold 后随第 2 次请求原样发回，工具结果配对', async () => {
  const f = fakeFetch([
    sseResponse(reply([thinkingBlock(0, '需要查一下', 'SIG_9'), textBlock(1, '我来查。'), toolBlock(2, 'toolu_1', 'echo', { q: '天气' })], 'tool_use', 40)),
    sseResponse(reply([textBlock(0, '查到了。')], 'end_turn', 8)),
  ])
  const m = anthropicModel('m', { apiKey: 'k', fetch: f.fetch, cache: false })
  const g = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('天气？'), model: m, instructions: 'SYS', tools: [echo] })
  const events: HueEvent[] = []; let r
  while (true) { const n = await g.next(); if (n.done) { r = n.value; break } events.push(n.value) }
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 2)
  assert.deepEqual(f.calls[1]!.body.messages, [
    { role: 'user', content: [{ type: 'text', text: '天气？' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '需要查一下', signature: 'SIG_9' },
      { type: 'text', text: '我来查。' },
      { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { q: '天气' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'echo:{"q":"天气"}' }] }] },
  ])
})

test('集成（真 core loop）：HTTP 401 → turn 以 error 结束，错误码和来源保留', async () => {
  const f = fakeFetch([errorResponse(401, { type: 'authentication_error', message: 'invalid x-api-key' })])
  const m = anthropicModel('m', { apiKey: 'bad', fetch: f.fetch })
  const g = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('hi'), model: m })
  let r; while (true) { const n = await g.next(); if (n.done) { r = n.value; break } }
  assert.equal(r.reason, 'error'); assert.equal(r.error?.code, 'model_error'); assert.equal(r.error?.source, 'ai:anthropic'); assert.equal(r.error?.retryable, false)
})

// ═════════ trace 钩子 ═════════

test('trace：给出实际发出的请求体和响应头，不含 API key；钩子抛错不影响请求', async () => {
  const seen: Array<{ type: string; [k: string]: unknown }> = []
  const { m } = modelWith([sseResponse(reply([textBlock(0, 'ok')], 'end_turn', 1), { headers: { 'request-id': 'req_9' } })], { trace: e => { seen.push(e); throw new Error('boom') } })
  const cs = await collect(m.stream(req([userText('q')], { instructions: 'SYS' }), signal()))
  assert.equal(cs.at(-1)!.type, 'finish')
  assert.deepEqual(seen.map(e => e.type), ['request', 'response'])
  assert.equal(JSON.parse(seen[0]!.body as string).system[0].text, 'SYS'); assert.match(seen[0]!.url as string, /\/v1\/messages$/)
  assert.equal(seen[1]!.status, 200); assert.equal((seen[1]!.headers as Record<string, string>)['request-id'], 'req_9')
  assert.ok(!JSON.stringify(seen).includes('k-test'))
})
