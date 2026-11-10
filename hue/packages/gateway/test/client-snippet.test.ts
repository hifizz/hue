import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { boot, send, sleep, TOKEN } from './helpers.js'

// ↓ 和 INTEGRATION.md 里"浏览器 / Node 客户端"一节是同一段代码(那边去掉了类型)。改一处要改另一处。
async function* watch(base: string, token: string, sessionId: string, after = 0, signal?: AbortSignal): AsyncGenerator<{ seq: number; type: string; [k: string]: any }> {
  const res = await fetch(`${base}/v1/sessions/${sessionId}/events?after=${after}`, { headers: { authorization: `Bearer ${token}` }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const reader = res.body!.getReader(), decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, i); buffer = buffer.slice(i + 2)
      const data = block.split('\n').find(l => l.startsWith('data: '))
      if (data) yield JSON.parse(data.slice(6))
    }
  }
}
// ↑

test('文档里的 watch():按顺序拿到事件;用最后看到的 seq 续传只拿到后面的;错误状态抛出带响应体的异常', async () => {
  const t = await boot()
  try {
    await send(t.url, 's1', 'hello')
    const ac = new AbortController(), seen: Array<{ seq: number; type: string }> = []
    for await (const e of watch(t.url, TOKEN, 's1', 0, ac.signal)) { seen.push(e); if (e.type === 'turn.ended') break }
    ac.abort()
    assert.deepEqual(seen.filter(e => e.seq).map(e => e.seq), [1, 2, 3, 4])
    const ac2 = new AbortController(), rest: string[] = []
    for await (const e of watch(t.url, TOKEN, 's1', 2, ac2.signal)) { rest.push(e.type); if (e.type === 'turn.ended') break }
    ac2.abort(); assert.deepEqual(rest, ['model.message', 'turn.ended'])
    await assert.rejects(watch(t.url, 'wrong-token-wrong-token', 's1').next(), /HTTP 401.*unauthorized/s)
  } finally { await t.close() }
})

test('文档里的 Node 签名示例:createHmac 的结果能通过渠道验签', async () => {
  const { webhookChannel } = await import('../src/index.js')
  const secret = 'webhook-secret-0123456789', replies: string[] = []
  const t = await boot({ channels: [webhookChannel({ name: 'hook', secret, send: async (_c, text) => { replies.push(text) } })] })
  try {
    // ↓ 同 INTEGRATION.md
    const body = JSON.stringify({ conversation: 'u1', text: 'hello' })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    const res = await fetch(`${t.url}/channels/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hue-timestamp': String(timestamp), 'x-hue-signature': signature }, body })
    // ↑
    assert.equal(res.status, 202)
    for (let i = 0; i < 100 && !replies.length; i++) await sleep(20)
    assert.deepEqual(replies, ['hi back'])
  } finally { await t.close() }
})
