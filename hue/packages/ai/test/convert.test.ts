// 消息转换测试：Hue 中立消息 → Anthropic 请求体的所有分支。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HueFault, type ModelRequest, type ToolSpec } from '@hue/core'
import { toAnthropicBody } from '../src/convert.js'

const tools: ToolSpec[] = [
  { name: 'get_weather', description: 'weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
]

const base = (messages: ModelRequest['messages'], extra: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: '', messages, tools, ...extra })

test('instructions → 顶层 system；不产生 system 角色', () => {
  const body = toAnthropicBody({ ...base([], { instructions: 'You are helpful.' }) }, 'claude-sonnet-4', 8_192)
  assert.equal(body.system, 'You are helpful.')
  assert.ok(body.messages.every(m => m.role === 'user' || m.role === 'assistant'))
})

test('user 文本与 data-URL 图片', () => {
  const body = toAnthropicBody(base([
    { role: 'user', content: [
      { type: 'text', text: '看这张图' },
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' },
    ] },
  ]), 'claude-sonnet-4', 8_192)
  assert.equal(body.messages.length, 1)
  const content = body.messages[0]!.content
  assert.deepEqual(content[0], { type: 'text', text: '看这张图' })
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } })
})

test('tool 消息拆成每结果一条 user 消息，带 tool_result 块', () => {
  const body = toAnthropicBody(base([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool-call', callId: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] },
    { role: 'tool', content: [
      { type: 'tool-result', callId: 'call_1', name: 'get_weather', isError: false, content: [{ type: 'text', text: 'sunny' }] },
    ] },
  ]), 'claude-sonnet-4', 8_192)
  const last = body.messages.at(-1)!
  assert.equal(last.role, 'user')
  assert.deepEqual(last.content[0], { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'sunny' }] })
})

test('json 工具结果序列化成文本块', () => {
  const body = toAnthropicBody(base([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool-call', callId: 'call_1', name: 'get_weather', input: {} }] },
    { role: 'tool', content: [
      { type: 'tool-result', callId: 'call_1', name: 'get_weather', isError: false, content: [{ type: 'json', value: { temp: 15 } }] },
    ] },
  ]), 'claude-sonnet-4', 8_192)
  const last = body.messages.at(-1)!
  assert.deepEqual(last.content[0] as any, { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '{"temp":15}' }] })
})

test('assistant thinking 块：带签名保留，无签名丢弃', () => {
  const body = toAnthropicBody(base([
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'secret', providerMetadata: { anthropic: { signature: 'SIG' } } },
      { type: 'reasoning', text: 'unsigned' },
      { type: 'text', text: 'answer' },
    ] },
  ]), 'claude-sonnet-4', 8_192)
  const content = body.messages[0]!.content
  assert.equal(content.length, 2) // 无签名推理被丢弃
  assert.deepEqual(content[0], { type: 'thinking', thinking: 'secret', signature: 'SIG' })
  assert.deepEqual(content[1], { type: 'text', text: 'answer' })
})

test('__raw 坏参数：能修复就修复，修不了抛 HueFault(invalid_tool_input)', () => {
  const ok = toAnthropicBody(base([
    { role: 'assistant', content: [{ type: 'tool-call', callId: 'c1', name: 'get_weather', input: { __raw: '{"city":"Oslo"}' } }] },
  ]), 'claude-sonnet-4', 8_192)
  assert.deepEqual((ok.messages[0]!.content[0] as any).input, { city: 'Oslo' })

  assert.throws(() => toAnthropicBody(base([
    { role: 'assistant', content: [{ type: 'tool-call', callId: 'c2', name: 'get_weather', input: { __raw: '{"city":' } }] },
  ]), 'claude-sonnet-4', 8_192), (e: unknown) => e instanceof HueFault)
})

test('toolChoice 映射：required→any，{name}→tool', () => {
  const a = toAnthropicBody(base([], { toolChoice: 'required' }), 'claude-sonnet-4', 8_192)
  assert.deepEqual(a.tool_choice, { type: 'any' })
  const b = toAnthropicBody(base([], { toolChoice: { name: 'get_weather' } }), 'claude-sonnet-4', 8_192)
  assert.deepEqual(b.tool_choice, { type: 'tool', name: 'get_weather' })
  const c = toAnthropicBody(base([], { toolChoice: 'none' }), 'claude-sonnet-4', 8_192)
  assert.deepEqual(c.tool_choice, { type: 'none' })
})

test('settings.maxOutputTokens 覆盖默认 max_tokens', () => {
  const body = toAnthropicBody({ ...base([]), settings: { maxOutputTokens: 123 } }, 'claude-sonnet-4', 8_192)
  assert.equal(body.max_tokens, 123)
})

test('非图片 FilePart 抛 HueFault', () => {
  assert.throws(() => toAnthropicBody(base([
    { role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', url: 'https://x.test/a.pdf' }] },
  ]), 'claude-sonnet-4', 8_192), (e: unknown) => e instanceof HueFault)
})
