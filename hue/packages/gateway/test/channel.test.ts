import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sign, webhookChannel } from '../src/index.js'
import { boot, openStream, post, sleep } from './helpers.js'

const SECRET = 'webhook-secret-0123456789'
const ts = () => Math.floor(Date.now() / 1000)

async function setup(over: Parameters<typeof boot>[0] = {}, sendImpl?: (c: string, t: string) => Promise<void>) {
  const replies: Array<[string, string]> = []
  const channel = webhookChannel({ name: 'hook', secret: SECRET, send: sendImpl ?? (async (c, t) => { replies.push([c, t]) }) })
  const t = await boot({ channels: [channel], ...over })
  const hook = (body: unknown, o: { ts?: number; secret?: string; headers?: Record<string, string>; signedBody?: string; path?: string } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body), stamp = o.ts ?? ts()
    return fetch(`${t.url}${o.path ?? '/channels/hook'}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hue-timestamp': String(stamp), 'x-hue-signature': sign(o.secret ?? SECRET, stamp, o.signedBody ?? raw), ...o.headers }, body: raw })
  }
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await sleep(20); assert.ok(f(), 'timed out') }
  return { t, replies, hook, until }
}

test('签名通过 → 202；不需要 bearer token；回复在 turn 结束后发回平台；事件同时能从 API 看到', async () => {
  const { t, replies, hook, until } = await setup()
  try {
    const r = await hook({ conversation: 'u1', text: 'hello' }); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { status: 'started', sessionId: 'hook:u1' })
    await until(() => replies.length === 1); assert.deepEqual(replies, [['u1', 'hi back']])
    const s = await openStream(`${t.url}/v1/sessions/hook:u1/events`); await s.waitFor(e => e.event === 'turn.ended'); s.close()
  } finally { await t.close() }
})

test('验签：签名不对 / 密钥不对 / 正文被改 / 时间戳过期 / 缺头 → 401，且不会启动 agent', async () => {
  const { t, hook } = await setup()
  try {
    const body = { conversation: 'u1', text: 'hello' }
    for (const r of [
      await hook(body, { headers: { 'x-hue-signature': 'sha256=00' } }),
      await hook(body, { secret: 'another-secret-0123456789' }),
      await hook(body, { signedBody: JSON.stringify({ conversation: 'u1', text: 'something else' }) }),
      await hook(body, { ts: ts() - 600 }), await hook(body, { ts: ts() + 600 }),
      await hook(body, { headers: { 'x-hue-timestamp': 'abc' } }),
      await fetch(`${t.url}/channels/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    ]) { assert.equal(r.status, 401); assert.equal((await r.json() as any).error.code, 'bad_signature') }
    assert.deepEqual(t.agent.runs, [])
  } finally { await t.close() }
})

test('渠道的 token 不能当 API 的 bearer，API 的 bearer 也不能冒充渠道', async () => {
  const { t } = await setup()
  try {
    assert.equal((await post(`${t.url}/channels/hook`, { conversation: 'u', text: 'hello' })).status, 401)
    assert.equal((await fetch(`${t.url}/v1/sessions/hook:u`, { headers: { 'x-hue-signature': 'x' } })).status, 401)
  } finally { await t.close() }
})

test('不是消息的事件（心跳等）→ 200 ignored；坏 JSON → 400；未知渠道 404；方法不对 405', async () => {
  const { t, hook } = await setup()
  try {
    assert.deepEqual(await (await hook({ type: 'ping' })).json(), { status: 'ignored' })
    assert.deepEqual(await (await hook({ conversation: 'u', text: '   ' })).json(), { status: 'ignored' })
    assert.equal((await hook('{nope')).status, 400)
    assert.equal((await hook({ conversation: 'u', text: 'hi' }, { path: '/channels/other' })).status, 404)
    assert.equal((await fetch(`${t.url}/channels/hook`)).status, 405)
    assert.deepEqual(t.agent.runs, [])
  } finally { await t.close() }
})

test('会话 ID：规矩的对话 ID 原样用，奇怪的（空格、斜杠、中文）用哈希，且不会互相撞；同一个对话总是同一个会话', async () => {
  const { t, hook, replies, until } = await setup()
  try {
    const id = async (c: string) => ((await (await hook({ conversation: c, text: 'hello' })).json()) as any).sessionId as string
    assert.equal(await id('U123.abc'), 'hook:U123.abc')
    const a = await id('a/b c'), b = await id('a/b_c'), z = await id('中文')
    assert.match(a, /^hook:h-[0-9a-f]{32}$/); assert.match(z, /^hook:h-[0-9a-f]{32}$/); assert.notEqual(a, b)
    await until(() => replies.length === 4)
    await sleep(30); assert.equal(await id('a/b c'), a)
  } finally { await t.close() }
})

test('对话里的第二条消息：会话在跑就是插话（steered），回复仍然发到这个对话', async () => {
  const { t, hook, replies, until } = await setup()
  try {
    assert.equal(((await (await hook({ conversation: 'u1', text: 'slow' })).json()) as any).status, 'started')
    assert.equal(((await (await hook({ conversation: 'u1', text: 'one more thing' })).json()) as any).status, 'steered')
    t.agent.release('hook:u1'); await until(() => replies.length === 1); assert.deepEqual(replies, [['u1', 'slow done']])
  } finally { await t.close() }
})

test('被打断的 turn：回复里注明停止原因', async () => {
  const { t, hook, replies, until } = await setup()
  try {
    await hook({ conversation: 'u1', text: 'slow' }); await sleep(30)
    await post(`${t.url}/v1/sessions/hook:u1/interrupt`, {})
    await until(() => replies.length === 1); assert.match(replies[0]![1], /\(stopped: interrupted\)$/)
  } finally { await t.close() }
})

test('agent 出错：平台上只收到通用的道歉，不泄露内部错误；API 事件流里有细节', async () => {
  const { t, hook, replies, until } = await setup()
  try {
    const s = await openStream(`${t.url}/v1/sessions/hook:u1/events`)
    await hook({ conversation: 'u1', text: 'boom' }); await until(() => replies.length === 1)
    assert.equal(replies[0]![1], 'Sorry, something went wrong on my side.'); assert.doesNotMatch(replies[0]![1], /kaboom/)
    assert.equal((await s.waitFor(e => e.event === 'ext')).data.data.message, 'kaboom'); s.close()
  } finally { await t.close() }
})

test('发回复失败：记成 gateway.error 事件，gateway 和会话都不受影响', async () => {
  const { t, hook } = await setup({}, async () => { throw new Error('slack is down') })
  try {
    const s = await openStream(`${t.url}/v1/sessions/hook:u1/events`)
    await hook({ conversation: 'u1', text: 'hello' })
    const e = await s.waitFor(e => e.event === 'ext'); assert.match(e.data.data.message, /could not send a reply: slack is down/); s.close()
    assert.equal((await fetch(`${t.url}/healthz`)).status, 200)
  } finally { await t.close() }
})

test('限流：验签没过的请求不占渠道的配额；通过的超出配额 429', async () => {
  const { t, hook } = await setup({ rateLimitPerMinute: 2 })
  try {
    for (let i = 0; i < 6; i++) assert.equal((await hook({ conversation: 'c', text: 'hello' }, { secret: 'attacker-secret-0123456789' })).status, 401)
    assert.equal((await hook({ conversation: 'c1', text: 'hello' })).status, 202)
    assert.equal((await hook({ conversation: 'c2', text: 'hello' })).status, 202)
    assert.equal((await hook({ conversation: 'c3', text: 'hello' })).status, 429)
  } finally { await t.close() }
})

test('webhookChannel 本身：密钥太短抛错；sign 对同样的输入给同样的结果、对不同的输入给不同的结果', () => {
  assert.throws(() => webhookChannel({ name: 'x', secret: 'short', send: async () => {} }), /at least 16/)
  assert.equal(sign(SECRET, 1, 'a'), sign(SECRET, 1, 'a')); assert.match(sign(SECRET, 1, 'a'), /^sha256=[0-9a-f]{64}$/)
  assert.notEqual(sign(SECRET, 1, 'a'), sign(SECRET, 2, 'a')); assert.notEqual(sign(SECRET, 1, 'a'), sign(SECRET, 1, 'b')); assert.notEqual(sign(SECRET, 1, 'a'), sign('other-secret-0123456789', 1, 'a'))
})
