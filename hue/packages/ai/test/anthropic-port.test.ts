// 端口级测试：factory 行为 + 请求头/URL/错误翻译（fetch mock，不碰网络）。
// 真实 API 的合同测试在 contracts.test.ts，没有 key 会自动 skip。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ai } from '../src/index.js'
import { messageDelta, messageStart, messageStop, textBlock, toSSEText } from './fixtures.js'

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY
test.after(() => { if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY })

test('ai(): 只认 anthropic 前缀，其他 provider 返回 undefined', () => {
  assert.ok(ai('anthropic:claude-sonnet-4'))
  assert.equal(ai('openai:gpt-4o'), undefined)
})

test('ai(): specVersion/id/contextWindow 符合合同要求', () => {
  const port = ai('anthropic:claude-sonnet-4', { apiKey: 'k' })!
  assert.equal(port.specVersion, 'hue.model.v1')
  assert.match(port.id, /^[a-z0-9-]+:.+/)
  assert.ok(port.info.contextWindow > 0)
})

test('stream(): 请求头带 x-api-key / anthropic-version / stream:true，URL 拼在 baseUrl 上', async () => {
  let captured: { url: string; init: RequestInit } | undefined
  mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    captured = { url: String(url), init }
    return new Response('{"error":{"type":"invalid_request_error","message":"bad"}}', { status: 400 })
  })
  try {
    const port = ai('anthropic:claude-sonnet-4', { apiKey: 'k', baseUrl: 'http://127.0.0.1:1' })!
    const chunks: unknown[] = []
    for await (const c of port.stream({ instructions: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, new AbortController().signal)) chunks.push(c)
    assert.equal(chunks.length, 1)
    assert.equal((chunks[0] as any).type, 'error')
    assert.equal((chunks[0] as any).error.data?.status, 400)
    assert.equal(captured!.url, 'http://127.0.0.1:1/v1/messages')
    const headers = captured!.init.headers as Record<string, string>
    assert.equal(headers['x-api-key'], 'k')
    assert.ok(headers['anthropic-version'])
    assert.equal((captured!.init.body as string).includes('"stream":true'), true)
  } finally {
    mock.restoreAll()
  }
})

test('stream(): 429/5xx 标记 retryable，400 不标记', async () => {
  for (const [status, expected] of [[429, true], [500, true], [400, false]] as const) {
    mock.method(globalThis, 'fetch', async () => new Response('{"error":{"type":"x","message":"y"}}', { status }))
    try {
      const port = ai('anthropic:claude-sonnet-4', { apiKey: 'k' })!
      const chunks: unknown[] = []
      for await (const c of port.stream({ instructions: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, new AbortController().signal)) chunks.push(c)
      assert.equal((chunks[0] as any).type, 'error')
      assert.equal((chunks[0] as any).error.retryable, expected, `status ${status}`)
      assert.equal((chunks[0] as any).error.code, 'model_error')
    } finally {
      mock.restoreAll()
    }
  }
})

test('stream(): 网络异常（非 abort）→ model_error chunk，不抛出', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed') })
  try {
    const port = ai('anthropic:claude-sonnet-4', { apiKey: 'k' })!
    const chunks: unknown[] = []
    for await (const c of port.stream({ instructions: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, new AbortController().signal)) chunks.push(c)
    assert.equal((chunks[0] as any).type, 'error')
    assert.equal((chunks[0] as any).error.code, 'model_error')
  } finally {
    mock.restoreAll()
  }
})

test('stream(): 已 abort 的 signal 在 fetch 前就终止（抛 AbortError）', async () => {
  const ac = new AbortController(); ac.abort()
  const port = ai('anthropic:claude-sonnet-4', { apiKey: 'k' })!
  await assert.rejects(async () => {
    for await (const _ of port.stream({ instructions: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, ac.signal)) void _
  }, (e: any) => e?.name === 'AbortError')
})

test('stream(): fetch mock 返回 SSE 事件 → 完整管线出 ModelChunk', async () => {
  const sse = toSSEText([messageStart(3), ...textBlock(0, 'hi'), messageDelta('end_turn', 2), messageStop()])
  mock.method(globalThis, 'fetch', async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  try {
    const port = ai('anthropic:claude-sonnet-4', { apiKey: 'k' })!
    const chunks: unknown[] = []
    for await (const c of port.stream({ instructions: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }, new AbortController().signal)) chunks.push(c)
    assert.ok(chunks.some(c => (c as any).type === 'text-delta'))
    assert.equal((chunks.at(-1) as any).type, 'finish')
    assert.equal((chunks.at(-1) as any).usage.inputTokens, 3)
  } finally {
    mock.restoreAll()
  }
})
