import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createGateway } from '../src/index.js'
import { auth, boot, fakeAgent, memStore, openStream, post, raw, send, sleep, TOKEN, types } from './helpers.js'

const settled = async (base: string, id: string) => {
  for (let i = 0; i < 100; i++) { const r = await fetch(`${base}/v1/sessions/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } }); if (r.status === 200 && !(await r.json() as { running: boolean }).running) return; await sleep(20) }
  throw new Error('session did not settle')
}
const get = (url: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => fetch(url, { headers })
const stub = { run: async function* () {}, steer: () => false, interrupt: () => false }

// ═════════ 配置 ═════════

test('配置：没有 token 必须显式 insecureNoAuth；token 太短、渠道名不合法、渠道重名都直接抛错', () => {
  const base = { agent: stub, store: memStore() }
  assert.throws(() => createGateway(base), /tokens/)
  assert.throws(() => createGateway({ ...base, tokens: [] }), /tokens/)
  assert.throws(() => createGateway({ ...base, tokens: ['short'] }), /at least 16/)
  assert.doesNotThrow(() => createGateway({ ...base, insecureNoAuth: true }))
  const ch = (name: string) => ({ name, verify: () => true, parse: () => undefined, reply: async () => {} })
  assert.throws(() => createGateway({ ...base, tokens: [TOKEN], channels: [ch('Bad_Name')] }), /channel name/)
  assert.throws(() => createGateway({ ...base, tokens: [TOKEN], channels: [ch('a'), ch('a')] }), /duplicate/)
})

test('listen：不鉴权只能绑回环；绑非回环地址必须配 allowedHosts', async () => {
  const store = memStore()
  await assert.rejects(createGateway({ agent: stub, store, insecureNoAuth: true }).listen(0, '0.0.0.0'), /refusing to listen/)
  await assert.rejects(createGateway({ agent: stub, store, tokens: [TOKEN] }).listen(0, '0.0.0.0'), /allowedHosts/)
  const g = createGateway({ agent: stub, store, tokens: [TOKEN], allowedHosts: ['gw.example.com'] })
  const { port } = await g.listen(0, '0.0.0.0'); assert.ok(port > 0); await g.close()
})

test('可以挂到自己的 http.Server 上（handler）', async () => {
  const store = memStore(); const gw = createGateway({ agent: fakeAgent(store), store, tokens: [TOKEN] })
  const server = createServer(gw.handler); await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    assert.equal((await send(base, 's1', 'hello')).status, 202)
    await settled(base, 's1'); assert.equal(store.events.filter(e => e.type === 'turn.ended').length, 1)
  } finally { await new Promise(r => server.close(r)) }
})

// ═════════ 鉴权、Host、Origin ═════════

test('鉴权：没有 / 错的 token 是 401 且带 WWW-Authenticate；多个 token 都能用；scheme 不分大小写；/healthz 不需要鉴权', async () => {
  const t = await boot({ tokens: [TOKEN, 'second-token-abcdefghij'] })
  try {
    const url = `${t.url}/v1/sessions/none`
    const no = await get(url, {}); assert.equal(no.status, 401); assert.equal(no.headers.get('www-authenticate'), 'Bearer')
    assert.equal((await get(url, { authorization: 'Bearer nope-nope-nope-nope' })).status, 401)
    assert.equal((await get(url, { authorization: `Basic ${TOKEN}` })).status, 401)
    assert.equal((await get(url, { authorization: `Bearer ${TOKEN}x` })).status, 401, '前缀相同也不行')
    assert.equal((await get(url, { authorization: `Bearer ${TOKEN.slice(0, -3)}` })).status, 401, '真 token 的前缀也不行')
    for (const tk of [TOKEN, 'second-token-abcdefghij']) assert.equal((await get(url, { authorization: `bearer ${tk}` })).status, 404, '通过鉴权，只是会话不存在')
    assert.equal((await fetch(`${t.url}/healthz`)).status, 200)
    assert.doesNotMatch(JSON.stringify(await no.json()), new RegExp(TOKEN))
  } finally { await t.close() }
})

test('insecureNoAuth：不带 token 就能用', async () => {
  const t = await boot({ tokens: undefined, insecureNoAuth: true })
  try { assert.equal((await fetch(`${t.url}/v1/sessions/none`)).status, 404) } finally { await t.close() }
})

test('DNS rebinding：不认识的 Host 一律 403（/healthz 除外）；配了 allowedHosts 的域名（带端口）可以', async () => {
  const t = await boot({ allowedHosts: ['gw.example.com', '127.0.0.1'] })
  try {
    const url = `${t.url}/v1/sessions/none`
    const evil = await raw(url, { headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` } })
    assert.equal(evil.status, 403); assert.match(evil.body, /forbidden_host/)
    assert.equal((await raw(url, { headers: { host: 'GW.example.com:8443', authorization: `Bearer ${TOKEN}` } })).status, 404)
    assert.equal((await raw(`${t.url}/healthz`, { headers: { host: 'evil.example.com' } })).status, 200)
  } finally { await t.close() }
})

test('Origin：带不在白名单的 Origin 是 403；在白名单的回 CORS 头，预检返回 204；不带 Origin 没有 CORS 头', async () => {
  const t = await boot({ allowedOrigins: ['https://app.example.com'] })
  try {
    const url = `${t.url}/v1/sessions/none`, h = { authorization: `Bearer ${TOKEN}` }
    const bad = await raw(url, { headers: { ...h, origin: 'https://evil.com' } }); assert.equal(bad.status, 403); assert.match(bad.body, /forbidden_origin/)
    const ok = await raw(url, { headers: { ...h, origin: 'https://app.example.com' } })
    assert.equal(ok.status, 404); assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com'); assert.equal(ok.headers.vary, 'Origin')
    const pre = await raw(url, { method: 'OPTIONS', headers: { origin: 'https://app.example.com' } })
    assert.equal(pre.status, 204); assert.match(String(pre.headers['access-control-allow-headers']), /authorization/)
    assert.equal((await raw(url, { method: 'OPTIONS', headers: { origin: 'https://evil.com' } })).status, 403)
    assert.equal((await raw(url, { headers: h })).headers['access-control-allow-origin'], undefined)
  } finally { await t.close() }
})

test('限流：每个主体每分钟 N 个，超出 429 带 Retry-After，窗口过去后恢复；鉴权失败的请求不占配额', async () => {
  let clock = 1_000_000
  const t = await boot({ rateLimitPerMinute: 3, now: () => clock })
  try {
    const url = `${t.url}/v1/sessions/none`
    for (let i = 0; i < 10; i++) assert.equal((await get(url, { authorization: 'Bearer wrong-wrong-wrong-wrong' })).status, 401)
    for (let i = 0; i < 3; i++) assert.equal((await get(url)).status, 404)
    const limited = await get(url); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    clock += 60_001; assert.equal((await get(url)).status, 404)
  } finally { await t.close() }
})

// ═════════ 请求校验 ═════════

test('请求体：非 JSON 内容类型 415；坏 JSON 400；空文本 400；声明长度超限 413；文本太长 413', async () => {
  const t = await boot({ maxBodyBytes: 200 })
  try {
    const url = `${t.url}/v1/sessions/s1/messages`
    assert.equal((await post(url, 'hi', { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' })).status, 415)
    const bad = await post(url, '{nope'); assert.equal(bad.status, 400); assert.equal((await bad.json() as any).error.code, 'invalid_json')
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 5 }, null]) assert.equal((await post(url, body)).status, 400, JSON.stringify(body))
    assert.equal((await post(url, { text: 'x'.repeat(300) })).status, 413)
    assert.equal(t.store.events.length, 0, '被拒绝的请求没有启动任何 agent')
  } finally { await t.close() }
  const chunked = await boot({ maxBodyBytes: 200 })
  try {
    // 分块传输没有声明长度，只能边读边数；超了回 413 或者直接断开，但绝不能启动 agent
    const r = await raw(`${chunked.url}/v1/sessions/s1/messages`, { method: 'POST', headers: { ...auth, 'transfer-encoding': 'chunked' }, chunks: ['{"text":"', 'x'.repeat(150), 'y'.repeat(150), '"}'] }).catch(() => ({ status: 0 }))
    assert.ok(r.status === 413 || r.status === 0, String(r.status)); assert.deepEqual(chunked.agent.runs, [])
  } finally { await chunked.close() }
  const big = await boot()
  try { const r = await send(big.url, 's1', 'x'.repeat(100_001)); assert.equal(r.status, 413); assert.equal((await r.json() as any).error.code, 'text_too_long') } finally { await big.close() }
})

test('路由：未知路径 404；会话 ID 不合法 400（含路径穿越）；方法不对 405 并带 Allow', async () => {
  const t = await boot()
  try {
    const h = { authorization: `Bearer ${TOKEN}` }
    assert.equal((await get(`${t.url}/v2/anything`)).status, 404)
    for (const id of ['..%2Fetc', '-leading', 'a b', '%E4%B8%AD', '%zz', 'x'.repeat(129)]) assert.equal((await get(`${t.url}/v1/sessions/${id}`, h)).status, 400, id)
    const m = await get(`${t.url}/v1/sessions/s1/messages`, h); assert.equal(m.status, 405); assert.equal(m.headers.get('allow'), 'POST')
    assert.equal((await post(`${t.url}/v1/sessions/s1/events`, {})).status, 405)
    assert.equal((await post(`${t.url}/v1/sessions/s1`, {})).status, 405)
  } finally { await t.close() }
})

// ═════════ 发消息、事件流 ═════════

test('发消息 → 202 started；事件流里依次是 turn.started / user.message / delta / model.message / turn.ended；durable 带 id（=seq），delta 不带', async () => {
  const t = await boot()
  try {
    const stream = await openStream(`${t.url}/v1/sessions/s1/events`)
    const r = await send(t.url, 's1', 'hello'); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { status: 'started', sessionId: 's1' })
    await stream.waitFor(e => e.event === 'turn.ended')
    assert.deepEqual(types(stream), ['turn.started', 'user.message', 'model.delta', 'model.message', 'turn.ended'])
    assert.deepEqual(stream.events.map(e => e.id), ['1', '2', undefined, '3', '4'])
    assert.equal(stream.events[3]!.data.message.content[0].text, 'hi back')
    assert.match(stream.comments[0]!, /stream open/)
    stream.close()
  } finally { await t.close() }
})

test('回放：after / Last-Event-ID 之后的 durable 事件从 store 读；非法值 400；回放里没有 delta', async () => {
  const t = await boot()
  try {
    await send(t.url, 's1', 'hello'); await settled(t.url, 's1')
    const all = await openStream(`${t.url}/v1/sessions/s1/events`); await all.waitFor(e => e.event === 'turn.ended')
    assert.deepEqual(all.events.map(e => e.id), ['1', '2', '3', '4']); all.close()
    const read = t.store.read.bind(t.store), asked: Array<number | undefined> = []; t.store.read = (id, o) => { asked.push(o?.fromSeq); return read(id, o) }
    const after = await openStream(`${t.url}/v1/sessions/s1/events?after=2`); await after.waitFor(e => e.event === 'turn.ended')
    assert.deepEqual(asked, [3], 'store 只被要求读 after 之后的')
    assert.deepEqual(after.events.map(e => e.id), ['3', '4']); after.close()
    const hdr = await openStream(`${t.url}/v1/sessions/s1/events`, { authorization: `Bearer ${TOKEN}`, 'last-event-id': '3' }); await hdr.waitFor(e => e.event === 'turn.ended')
    assert.deepEqual(hdr.events.map(e => e.id), ['4']); hdr.close()
    for (const bad of ['-1', 'x', '1.5']) assert.equal((await get(`${t.url}/v1/sessions/s1/events?after=${bad}`)).status, 400, bad)
  } finally { await t.close() }
})

test('中途加入：先回放已有的，再接实时，每个 seq 恰好一次、不缺', async () => {
  const t = await boot()
  try {
    await send(t.url, 's1', 'slow')
    const stream = await openStream(`${t.url}/v1/sessions/s1/events`); await stream.waitFor(e => e.event === 'user.message')
    await send(t.url, 's1', 'one more'); await stream.waitFor(e => e.event === 'user.message' && e.data.steer)
    t.agent.release('s1'); await stream.waitFor(e => e.event === 'turn.ended')
    assert.deepEqual(stream.events.map(e => Number(e.id)), [1, 2, 3, 4, 5]); stream.close()
  } finally { await t.close() }
})

for (const mode of ['读之前卡住（回放会读到新事件，实时流里也有：靠 seq 去重）', '读完快照再卡住（回放读不到新事件，只有实时流里有：靠缓冲）'] as const) {
  test(`回放比实时慢时，期间又产生了事件——${mode}：不重复、不丢`, async () => {
    const t = await boot()
    try {
      await send(t.url, 's1', 'slow'); await sleep(30)
      const read = t.store.read.bind(t.store), asked: Array<number | undefined> = []
      t.store.read = async function* (id, o) {
        asked.push(o?.fromSeq)
        if (mode.startsWith('读之前')) await sleep(200)
        const snapshot: any[] = []; for await (const e of read(id, o)) snapshot.push(e)
        if (!mode.startsWith('读之前')) await sleep(200)
        yield* snapshot
      }
      const opening = openStream(`${t.url}/v1/sessions/s1/events`)
      await sleep(80); await send(t.url, 's1', 'during replay')
      const stream = await opening; t.agent.release('s1'); await stream.waitFor(e => e.event === 'turn.ended')
      const ids = stream.events.map(e => Number(e.id)); assert.deepEqual(ids, [1, 2, 3, 4, 5], JSON.stringify(ids)); stream.close()
      assert.deepEqual(asked, [1], '从 after+1 开始读')
    } finally { await t.close() }
  })
}

test('保活：空闲时定期发注释行', async () => {
  const t = await boot({ keepAliveMs: 30 })
  try { const s = await openStream(`${t.url}/v1/sessions/s1/events`); await sleep(150); assert.ok(s.comments.filter(c => c.includes('keep-alive')).length >= 2); s.close() } finally { await t.close() }
})

test('事件流数量上限：超出 429；关掉一个后又可以开', async () => {
  const t = await boot({ maxStreams: 1 })
  try {
    const a = await openStream(`${t.url}/v1/sessions/s1/events`); assert.equal(a.status, 200)
    assert.equal((await get(`${t.url}/v1/sessions/s1/events`)).status, 429)
    a.close(); await sleep(100)
    const b = await openStream(`${t.url}/v1/sessions/s1/events`); assert.equal(b.status, 200); b.close()
  } finally { await t.close() }
})

test('事件流需要鉴权', async () => {
  const t = await boot()
  try { assert.equal((await get(`${t.url}/v1/sessions/s1/events`, {})).status, 401) } finally { await t.close() }
})

// ═════════ 会话状态、插话、打断 ═════════

test('GET 会话：不存在 404；在跑时 running；结束后 lastSeq', async () => {
  const t = await boot()
  try {
    assert.equal((await get(`${t.url}/v1/sessions/s1`)).status, 404)
    await send(t.url, 's1', 'slow'); await sleep(30)
    assert.deepEqual(await (await get(`${t.url}/v1/sessions/s1`)).json(), { sessionId: 's1', running: true, lastSeq: 2, pendingInputs: [] })
    t.agent.release('s1'); await settled(t.url, 's1')
    assert.deepEqual(await (await get(`${t.url}/v1/sessions/s1`)).json(), { sessionId: 's1', running: false, lastSeq: 4, pendingInputs: [] })
  } finally { await t.close() }
})

test('会话在跑时再发消息 = 插话（steered），而不是再开一个；同时到的两条一条 started 一条 steered', async () => {
  const t = await boot()
  try {
    const [a, b] = await Promise.all([send(t.url, 's1', 'slow'), send(t.url, 's1', 'slow')])
    assert.deepEqual([(await a.json() as any).status, (await b.json() as any).status].sort(), ['started', 'steered'])
    assert.equal(t.agent.runs.length, 1)
    t.agent.release('s1'); await settled(t.url, 's1')
  } finally { await t.close() }
})

test('刚好在结束的会话：agent 不收插话 → 409 session_finishing（不丢消息，也不悄悄开新的）', async () => {
  const t = await boot({}, { noSteer: true })
  try {
    await send(t.url, 's1', 'slow'); await sleep(30)
    const r = await send(t.url, 's1', 'late'); assert.equal(r.status, 409); assert.equal((await r.json() as any).error.code, 'session_finishing'); assert.equal(r.headers.get('retry-after'), '1')
    t.agent.release('s1'); await settled(t.url, 's1')
  } finally { await t.close() }
})

test('打断：在跑的会话 202，turn 以 interrupted 结束；没在跑 409', async () => {
  const t = await boot()
  try {
    assert.equal((await post(`${t.url}/v1/sessions/s1/interrupt`, {})).status, 409)
    await send(t.url, 's1', 'slow'); const s = await openStream(`${t.url}/v1/sessions/s1/events`)
    assert.equal((await post(`${t.url}/v1/sessions/s1/interrupt`, {})).status, 202)
    const end = await s.waitFor(e => e.event === 'turn.ended'); assert.equal(end.data.reason, 'interrupted'); s.close()
    await settled(t.url, 's1'); assert.equal((await post(`${t.url}/v1/sessions/s1/interrupt`, {})).status, 409)
  } finally { await t.close() }
})

test('并发会话数上限：超出 429 + Retry-After，不启动 agent；有空位后可以', async () => {
  const t = await boot({ maxRuns: 1 })
  try {
    await send(t.url, 'a', 'slow')
    const r = await send(t.url, 'b', 'hello'); assert.equal(r.status, 429); assert.equal((await r.json() as any).error.code, 'too_many_runs'); assert.ok(r.headers.get('retry-after'))
    assert.deepEqual(t.agent.runs, ['slow'])
    assert.equal((await send(t.url, 'a', 'also a')).status, 202, '同一个会话的插话不占新的名额')
    t.agent.release('a'); await settled(t.url, 'a')
    assert.equal((await send(t.url, 'b', 'hello')).status, 202)
  } finally { await t.close() }
})

// ═════════ 人工批准 ═════════

test('批准：事件流里看到 input.requested；POST 答案后 agent 继续；accept 的 value 原样带回；同一个请求不能答两次', async () => {
  const t = await boot()
  try {
    const s = await openStream(`${t.url}/v1/sessions/s1/events`); await send(t.url, 's1', 'ask')
    const req = await s.waitFor(e => e.event === 'input.requested'); const id = req.data.requestId
    assert.equal(req.data.request.prompt, 'Allow it?')
    assert.deepEqual((await (await get(`${t.url}/v1/sessions/s1`)).json() as any).pendingInputs, [id])
    const ok = await post(`${t.url}/v1/sessions/s1/inputs/${id}`, { action: 'accept', value: { ok: true } }); assert.equal(ok.status, 200)
    const msg = await s.waitFor(e => e.event === 'model.message'); assert.equal(msg.data.message.content[0].text, 'answer:accept:{"ok":true}')
    assert.equal((await post(`${t.url}/v1/sessions/s1/inputs/${id}`, { action: 'accept' })).status, 404)
    s.close()
  } finally { await t.close() }
})

test('批准：decline 带理由；请求 ID 必须属于这个会话；答案格式不对 400；需要鉴权', async () => {
  const t = await boot()
  try {
    const s = await openStream(`${t.url}/v1/sessions/s1/events`); await send(t.url, 's1', 'ask')
    const id = (await s.waitFor(e => e.event === 'input.requested')).data.requestId
    assert.equal((await post(`${t.url}/v1/sessions/other/inputs/${id}`, { action: 'accept' })).status, 404, '别的会话批准不了')
    assert.equal((await post(`${t.url}/v1/sessions/s1/inputs/${id}`, { action: 'maybe' })).status, 400)
    assert.equal((await post(`${t.url}/v1/sessions/s1/inputs/${id}`, 'null')).status, 400)
    assert.equal((await post(`${t.url}/v1/sessions/s1/inputs/${id}`, { action: 'accept' }, { 'content-type': 'application/json' })).status, 401)
    assert.deepEqual((await (await get(`${t.url}/v1/sessions/s1`)).json() as any).pendingInputs, [id], '前面的失败请求没有消耗它')
    await post(`${t.url}/v1/sessions/s1/inputs/${id}`, { action: 'decline', reason: 'too risky' })
    assert.equal((await s.waitFor(e => e.event === 'model.message')).data.message.content[0].text, 'answer:decline:too risky'); s.close()
  } finally { await t.close() }
})

test('批准：超时按取消处理；会话被打断也按取消处理，不会一直挂着', async () => {
  const a = await boot({ inputTimeoutMs: 60 })
  try {
    const s = await openStream(`${a.url}/v1/sessions/s1/events`); await send(a.url, 's1', 'ask')
    assert.equal((await s.waitFor(e => e.event === 'model.message')).data.message.content[0].text, 'answer:cancel'); s.close()
  } finally { await a.close() }
  const b = await boot()
  try {
    const s = await openStream(`${b.url}/v1/sessions/s1/events`); await send(b.url, 's1', 'ask'); await s.waitFor(e => e.event === 'input.requested')
    await post(`${b.url}/v1/sessions/s1/interrupt`, {})
    assert.equal((await s.waitFor(e => e.event === 'model.message')).data.message.content[0].text, 'answer:cancel'); s.close()
  } finally { await b.close() }
})

// ═════════ 出错 ═════════

test('agent 抛错：事件流收到 gateway.error（非 durable），会话槽被释放，之后可以继续发', async () => {
  const t = await boot()
  try {
    const s = await openStream(`${t.url}/v1/sessions/s1/events`); await send(t.url, 's1', 'boom')
    const err = await s.waitFor(e => e.event === 'ext'); assert.equal(err.data.name, 'gateway.error'); assert.equal(err.data.data.message, 'kaboom'); assert.equal(err.id, undefined)
    await settled(t.url, 's1'); assert.deepEqual(await (await send(t.url, 's1', 'hello')).json(), { status: 'started', sessionId: 's1' }); s.close()
  } finally { await t.close() }
})

test('内部错误：客户端只看到通用的 500，细节只给 onError', async () => {
  const seen: unknown[] = []; const t = await boot({ onError: e => seen.push(e) })
  try {
    t.store.failLastSeq = true
    await send(t.url, 's1', 'hello').catch(() => {}); // 先让会话存在
    const r = await get(`${t.url}/v1/sessions/s1`); const body = await r.text()
    assert.equal(r.status, 500); assert.doesNotMatch(body, /secret|exploded/); assert.equal((JSON.parse(body) as any).error.code, 'internal')
    assert.match(String((seen[0] as Error).message), /exploded/)
  } finally { t.store.failLastSeq = false; await t.close() }
})

// ═════════ 关闭 ═════════

test('close()：结束所有事件流、打断在跑的会话并等它收尾、之后不再接受连接', async () => {
  const t = await boot()
  await send(t.url, 's1', 'slow'); const s = await openStream(`${t.url}/v1/sessions/s1/events`); await s.waitFor(e => e.event === 'user.message')
  await t.close(); await s.closed
  assert.equal(s.events.at(-1)!.event, 'turn.ended', '订阅者收到了被打断的收尾事件')
  assert.equal(t.store.events.findLast(e => e.type === 'turn.ended' && e.sessionId === 's1')!.type, 'turn.ended')
  assert.equal((t.store.events.findLast(e => e.type === 'turn.ended') as any).reason, 'interrupted')
  assert.equal(t.agent.active.size, 0)
  await assert.rejects(get(`${t.url}/healthz`))
})

test('close()：不理会打断的 agent 最多等 closeTimeoutMs，不会一直挂着', async () => {
  const t = await boot({ closeTimeoutMs: 100 })
  await send(t.url, 's1', 'deaf'); await sleep(30)
  const t0 = Date.now(); await t.close(); assert.ok(Date.now() - t0 < 3000, `close took ${Date.now() - t0}ms`)
})
