import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mcp, McpError, TransportError } from '../src/mcp/index.js'
import type { McpOptions } from '../src/mcp/index.js'
import { httpMock } from './mcp-http-server.js'
import type { HttpMockOptions } from './mcp-http-server.js'
import { ctxOf, run, text, toolsOf, until } from './mcp-helpers.js'

async function setup(o: HttpMockOptions = {}, c: Partial<McpOptions> & { fetch?: typeof fetch } = {}) {
  const srv = await httpMock({ stateDir: mkdtempSync(join(tmpdir(), 'hue-mcp-http-')), ...o })
  const server = mcp.http(srv.url, { name: 'web', ...c })
  const stop = async () => { await server.close(); await srv.close() }
  return { srv, server, stop }
}
const methods = (s: { seen: Array<{ body: { method?: string } }> }) => s.seen.map(x => x.body.method)

test('新协议：每个 POST 带 Accept（两种都收）、MCP-Protocol-Version、Mcp-Method；tools/call 带 Mcp-Name；没有 Mcp-Session-Id；没有 initialize', async () => {
  const { srv, server, stop } = await setup()
  try {
    const t = await toolsOf(server); assert.equal(text(await run(t.web__echo!, { text: 'h' })), 'echo:h')
    assert.deepEqual(methods(srv), ['server/discover', 'tools/list', 'tools/call'])
    for (const s of srv.seen) {
      assert.match(String(s.headers.accept), /application\/json/); assert.match(String(s.headers.accept), /text\/event-stream/)
      assert.equal(s.headers['mcp-protocol-version'], '2026-07-28'); assert.equal(s.headers['mcp-method'], s.body.method); assert.equal(s.headers['mcp-session-id'], undefined)
    }
    assert.equal(srv.seen[2]!.headers['mcp-name'], 'echo')
  } finally { await stop() }
})

test('SSE 响应：流里的进度通知交给 ctx.progress，保活注释忽略，最后一条是结果；MRTR 经 SSE 同样工作', async () => {
  const { server, stop } = await setup({ sse: true })
  try {
    const t = await toolsOf(server); const seen: unknown[] = []
    assert.equal(text(await run(t.web__progress!, {}, ctxOf({ progress: d => seen.push(d) }))), 'done'); assert.deepEqual(seen, [{ progress: 1, total: 2, message: 'half' }])
    assert.equal(text(await run(t.web__ask!, {}, ctxOf({ requestInput: async () => ({ action: 'accept', value: { name: 'bo' } }) }))), 'hello bo')
  } finally { await stop() }
})

const sql = { name: 'execute_sql', description: 'Run SQL', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' }, opts: { type: 'object', properties: { replicas: { type: 'integer', 'x-mcp-header': 'Replicas' }, dry: { type: 'boolean', 'x-mcp-header': 'Dry' } } } } } }

test('非 ASCII 的工具名：Mcp-Name 用 Base64 哨兵格式发，服务端解码后和请求体一致（否则会被 -32020 拒绝）', async () => {
  const { srv, server, stop } = await setup({ extra: [{ name: 'café', description: 'non-ascii name', inputSchema: { type: 'object' } }] })
  try {
    const t = await toolsOf(server); assert.equal(text(await run(t.web__caf_!, {})), 'called café {}')
    assert.equal(srv.seen.at(-1)!.headers['mcp-name'], `=?base64?${Buffer.from('café').toString('base64')}?=`)
  } finally { await stop() }
})

test('x-mcp-header：参数值映射成 Mcp-Param-* 头（嵌套属性、整数、布尔；null 和缺省的不发；非 ASCII 用 Base64）；写在不合法位置的工具被丢掉并提示', async () => {
  const warnings: string[] = []
  const bad = [
    { name: 'num', description: 'number header', inputSchema: { type: 'object', properties: { x: { type: 'number', 'x-mcp-header': 'X' } } } },
    { name: 'inarray', description: 'in array', inputSchema: { type: 'object', properties: { xs: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } } } },
    { name: 'dup', description: 'dup', inputSchema: { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Same' }, b: { type: 'string', 'x-mcp-header': 'same' } } } },
  ]
  const { srv, server, stop } = await setup({ extra: [sql, ...bad] }, { onWarning: w => warnings.push(w) })
  try {
    const t = await toolsOf(server)
    assert.ok('web__execute_sql' in t); assert.ok(!('web__num' in t) && !('web__inarray' in t) && !('web__dup' in t))
    assert.deepEqual(warnings.map(w => w.match(/"(\w+)"/)![1]), ['num', 'inarray', 'dup'])
    await run(t.web__execute_sql!, { region: 'us-west1', query: 'select 1', opts: { replicas: 3, dry: false } })
    const h = srv.seen.at(-1)!.headers
    assert.deepEqual([h['mcp-param-region'], h['mcp-param-replicas'], h['mcp-param-dry']], ['us-west1', '3', 'false'])
    await run(t.web__execute_sql!, { region: 'Hello, 世界', query: 'q', opts: null })
    const h2 = srv.seen.at(-1)!.headers
    assert.equal(h2['mcp-param-region'], `=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`); assert.equal(h2['mcp-param-replicas'], undefined)
  } finally { await stop() }
})

test('老 server（HTTP）：discover 得到不是新协议错误的 400 → 回退；initialize 的会话 ID 之后每个请求都带；缺 resultType 当 complete', async () => {
  const { srv, server, stop } = await setup({ mode: 'legacy' })
  try {
    const t = await toolsOf(server); assert.equal(text(await run(t.web__echo!, { text: 'l' })), 'echo:l')
    assert.deepEqual(methods(srv), ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    const sid = [...srv.sessions][0]!
    assert.deepEqual(srv.seen.slice(2).map(s => s.headers['mcp-session-id']), [sid, sid, sid])
    assert.equal(srv.seen[3]!.headers['mcp-protocol-version'], '2025-11-25')
  } finally { await stop() }
})

test('老协议的会话过期（404）：重新握手后重发一次；取消在老协议的 HTTP 上要发通知（关连接不算）', async () => {
  const { srv, server, stop } = await setup({ mode: 'legacy' })
  try {
    const t = await toolsOf(server); srv.sessions.clear()
    assert.equal(text(await run(t.web__echo!, { text: 'again' })), 'echo:again')
    assert.equal(methods(srv).filter(m => m === 'initialize').length, 2)

    const ac = new AbortController(); const p = run(t.web__hang!, {}, ctxOf({ signal: ac.signal }))
    await until(() => methods(srv).includes('tools/call') && srv.seen.some(s => (s.body.params as { name?: string })?.name === 'hang')); ac.abort()
    await assert.rejects(p, { name: 'AbortError' })
    await until(() => methods(srv).includes('notifications/cancelled'))
  } finally { await stop() }
})

test('新协议的取消：关掉响应流就是取消，不发 notifications/cancelled；server 看得到连接被关', async () => {
  const { srv, server, stop } = await setup()
  try {
    const t = await toolsOf(server); const ac = new AbortController(); const p = run(t.web__hang!, {}, ctxOf({ signal: ac.signal }))
    await until(() => srv.seen.some(s => (s.body.params as { name?: string })?.name === 'hang')); ac.abort()
    await assert.rejects(p, { name: 'AbortError' })
    await until(() => srv.closedByClient > 0); assert.equal(methods(srv).includes('notifications/cancelled'), false)
  } finally { await stop() }
})

test('不是"老 server"的失败不会被当成老 server：401 是错误；新协议的 -32020 是错误；连不上是传输错误', async () => {
  const a = await setup({ status: 401 })
  try { await assert.rejects(toolsOf(a.server), (e: unknown) => e instanceof McpError && /HTTP 401/.test(e.message)); assert.deepEqual(methods(a.srv), ['server/discover']) } finally { await a.stop() }

  const b = await setup({}, { versions: ['2026-07-28'] })
  try { // 假装 server 校验头失败：让客户端的头对不上（用 fetch 钩子改掉版本头）
    const bad = mcp.http(b.srv.url, { name: 'web', fetch: (u, i) => fetch(u, { ...i, headers: { ...(i!.headers as object), 'MCP-Protocol-Version': '1999-01-01' } }) })
    await assert.rejects(toolsOf(bad), (e: unknown) => e instanceof McpError && e.code === -32020); assert.equal(methods(b.srv).includes('initialize'), false)
  } finally { await b.stop() }

  const c = await setup(); const url = c.srv.url; await c.stop()
  await assert.rejects(toolsOf(mcp.http(url, { name: 'web' })), (e: unknown) => e instanceof TransportError)
})

test('流断了（响应没等到就断开）：只读工具用新 ID 重发一次；不可重复的告诉模型结果未知；JSON 模式和 SSE 模式都一样', async () => {
  for (const sse of [false, true]) {
    const { srv, server, stop } = await setup({ sse })
    try {
      const t = await toolsOf(server)
      assert.equal(text(await run(t['web__die-once']!, {})), 'survived die-once', `sse=${sse}`)
      const calls = srv.seen.filter(s => (s.body.params as { name?: string })?.name === 'die-once'); assert.equal(calls.length, 2); assert.notEqual(calls[0]!.body.id, calls[1]!.body.id)
      const unsafe = await run(t['web__die-once-unsafe']!, {}); assert.equal(unsafe.isError, true); assert.match(text(unsafe), /unknown whether it took effect/)
      assert.equal(srv.seen.filter(s => (s.body.params as { name?: string })?.name === 'die-once-unsafe').length, 1)
    } finally { await stop() }
  }
})

test('每个请求的 _meta 在 HTTP 上同样带齐；版本不对（-32022）换版本重发', async () => {
  const { srv, server, stop } = await setup({}, { versions: ['2099-01-01', '2026-07-28'] })
  try {
    const t = await toolsOf(server); await run(t.web__echo!, { text: 'q' })
    const metas = srv.seen.map(s => (s.body.params as { _meta: Record<string, unknown> })._meta['io.modelcontextprotocol/protocolVersion'])
    assert.deepEqual(metas, ['2099-01-01', '2026-07-28', '2026-07-28', '2026-07-28'])
    assert.equal(srv.seen[1]!.headers['mcp-protocol-version'], '2026-07-28')
  } finally { await stop() }
})
