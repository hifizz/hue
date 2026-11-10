import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { toolContract } from '@hue/core/contracts'
import { adapt, createClient, McpError, stdioTransport } from '../src/mcp/index.js'
import { tools as defs } from './mcp-mock.js'
import { alive, answerWith, capabilityCtx, ctxOf, run, stdio, text, toolsOf, until } from './mcp-helpers.js'
import type { Spawned } from './mcp-helpers.js'

const opened: Spawned[] = []
const open = (...a: Parameters<typeof stdio>) => { const s = stdio(...a); opened.push(s); return s }
after(async () => { await Promise.all(opened.map(s => s.server.close())) })
const NS = 'io.modelcontextprotocol/'
const methods = (s: Spawned) => s.received().map(m => m.method)

test('新协议：先 server/discover，不发 initialize；工具名带前缀，顺序是 server 给的，点号换成下划线；effects 由 annotations 推出', async () => {
  const s = open({ instructions: 'Use echo for echoes.' })
  const t = await toolsOf(s.server)
  assert.deepEqual(Object.keys(t).slice(0, 4), ['mock__echo', 'mock__write', 'mock__idem', 'mock__ask'])
  assert.ok('mock__dotted_name' in t, '服务商只接受 [a-zA-Z0-9_-]')
  assert.deepEqual([t.mock__echo!.effects, t.mock__idem!.effects, t.mock__write!.effects], ['none', 'idempotent', 'unsafe'])
  assert.equal(await s.server.instructions!(capabilityCtx), 'Use echo for echoes.')
  assert.deepEqual(methods(s), ['server/discover', 'tools/list'])
})

test('每个请求的 _meta 都带齐版本、能力（只声明 elicitation 表单）、身份；请求 ID 互不相同', async () => {
  const s = open(); const t = await toolsOf(s.server)
  await run(t.mock__echo!, { text: 'a' }); await run(t.mock__echo!, { text: 'b' })
  const reqs = s.received().filter(m => m.id !== undefined)
  assert.equal(reqs.length, 4)
  for (const r of reqs) {
    const meta = (r.params as { _meta: Record<string, unknown> })._meta
    assert.equal(meta[`${NS}protocolVersion`], '2026-07-28'); assert.deepEqual(meta[`${NS}clientCapabilities`], { elicitation: { form: {} } })
    assert.match(String((meta[`${NS}clientInfo`] as { name: string }).name), /hue/)
  }
  assert.equal(new Set(reqs.map(r => r.id)).size, 4)
})

test('结果转换：text、image→文件、audio/资源链接/嵌入资源→文本说明；structuredContent 进 data；isError 透传；协议错误变成给模型看的错误结果', async () => {
  const s = open(); const t = await toolsOf(s.server)
  const echo = await run(t.mock__echo!, { text: 'x' })
  assert.deepEqual([text(echo), echo.data, echo.isError], ['echo:x', { text: 'x' }, false])
  const rich = await run(t.mock__rich!, {})
  assert.deepEqual(rich.content.map(c => c.type), ['text', 'file', 'text', 'text', 'text', 'text'])
  assert.deepEqual(rich.content[1], { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' })
  assert.match(text(rich), /audio content \(audio\/wav\) omitted/); assert.match(text(rich), /resource link\] a\.txt file:\/\/\/a\.txt/); assert.match(text(rich), /\[resource file:\/\/\/b\.txt\]\nbee/); assert.match(text(rich), /binary resource file:\/\/\/c\.bin/)
  JSON.stringify(rich)
  const bad = await run(t.mock__fail!, {}); assert.deepEqual([bad.isError, text(bad)], [true, 'it broke'])
  const rpc = await run(t['mock__rpc-fail']!, {}); assert.deepEqual([rpc.isError, text(rpc)], [true, 'MCP error -32602: Unknown tool: nope'])
})

test('MRTR：一轮——input_required 变成 requestInput 的表单请求，答案和 requestState 放回原请求、用新 ID 重发', async () => {
  const s = open(); const t = await toolsOf(s.server); const asked: unknown[] = []
  const ctx = ctxOf({ requestInput: async r => { asked.push(r); return { action: 'accept', value: { name: 'ada' } } } })
  assert.equal(text(await run(t.mock__ask!, {}, ctx)), 'hello ada')
  assert.deepEqual(asked, [{ kind: 'form', prompt: 'Who are you?', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }])
  const calls = s.received().filter(m => m.method === 'tools/call')
  assert.equal(calls.length, 2); assert.notEqual(calls[0]!.id, calls[1]!.id)
  const retry = calls[1]!.params as Record<string, any>
  assert.deepEqual(retry.inputResponses, { who: { action: 'accept', content: { name: 'ada' } } }); assert.equal(retry.requestState, 'S1'); assert.deepEqual(retry.arguments, {})
  assert.equal((calls[0]!.params as Record<string, unknown>).requestState, undefined, '第一次请求不带 requestState')
})

test('MRTR：用户拒绝 → 把 decline 交给 server；两轮——第二次重发带的是原请求加这一轮的答案，不累积上一轮', async () => {
  const s = open(); const t = await toolsOf(s.server)
  assert.equal(text(await run(t.mock__ask!, {}, ctxOf({ requestInput: answerWith({ action: 'decline' }) }))), 'user declined')
  const ctx = ctxOf({ requestInput: async r => ({ action: 'accept', value: { name: r.prompt } }) })
  assert.equal(text(await run(t.mock__ask2!, {}, ctx)), 'got And the second? after clean')
})

test('MRTR：server 一直要输入 → 重试 5 轮后放弃，返回错误结果；maxInputRounds 可调', async () => {
  const s = open(); const t = await toolsOf(s.server)
  const out = await run(t.mock__loop!, {}, ctxOf({ requestInput: answerWith({ action: 'accept', value: {} }) }))
  assert.equal(out.isError, true); assert.match(text(out), /kept asking for more input \(5 rounds\)/)
  assert.equal(s.received().filter(m => m.method === 'tools/call').length, 6, '第一次加 5 次重发')
  const few = open({}, { maxInputRounds: 2 }); const loop = (await toolsOf(few.server)).mock__loop!
  await run(loop, {}, ctxOf({ requestInput: answerWith({ action: 'accept', value: {} }) }))
  assert.equal(few.received().filter(m => m.method === 'tools/call').length, 3)
})

test('MRTR：不支持的 input 类型（sampling）→ 明确的错误结果，不是崩溃', async () => {
  const t = await toolsOf(open().server); const out = await run(t.mock__sample!, {})
  assert.equal(out.isError, true); assert.match(text(out), /sampling\/createMessage.*does not support/)
})

test('进度通知 → ctx.progress', async () => {
  const t = await toolsOf(open().server); const seen: unknown[] = []
  await run(t.mock__progress!, {}, ctxOf({ progress: d => seen.push(d) }))
  assert.deepEqual(seen, [{ progress: 1, total: 2, message: 'half' }])
})

test('取消：signal 触发时发 notifications/cancelled（stdio 上唯一的取消办法），调用以 AbortError 结束，之后照常可用', async () => {
  const s = open(); const t = await toolsOf(s.server); const ac = new AbortController()
  const p = run(t.mock__hang!, {}, ctxOf({ signal: ac.signal }))
  await until(() => s.received().some(m => m.method === 'tools/call')); ac.abort()
  await assert.rejects(p, { name: 'AbortError' })
  const id = s.received().find(m => m.method === 'tools/call')!.id
  await until(() => s.stderr.includes(`cancelled:${id}`))
  assert.equal(text(await run(t.mock__echo!, { text: 'still' })), 'echo:still')
})

test('连接中途断了（进程退出）：只读的工具自动用新 ID 重发一次，重新拉起 server；不可重复的不重发，告诉模型结果未知', async () => {
  const s = open({ stateDir: mkdtempSync(join(tmpdir(), 'hue-mcp-')) }); const t = await toolsOf(s.server)
  assert.equal(text(await run(t['mock__die-once']!, {})), 'survived die-once')
  const calls = s.received().filter(m => m.method === 'tools/call' && (m.params as { name: string }).name === 'die-once')
  assert.equal(calls.length, 2); assert.notEqual(calls[0]!.id, calls[1]!.id)
  assert.equal(methods(s).filter(m => m === 'server/discover').length, 2, '新进程要重新探测')

  const unsafe = await run(t['mock__die-once-unsafe']!, {})
  assert.equal(unsafe.isError, true); assert.match(text(unsafe), /unknown whether it took effect/)
  assert.equal(s.received().filter(m => m.method === 'tools/call' && (m.params as { name: string }).name === 'die-once-unsafe').length, 1, '没有重发')
  assert.equal(text(await run(t.mock__echo!, { text: 'back' })), 'echo:back', '下一次调用会重新拉起')
})

test('并发调用按 ID 各自对上；工具列表分页合并、顺序不变；列表在缓存期内只取一次', async () => {
  const s = open({ pages: true }); const t = await toolsOf(s.server)
  assert.equal(Object.keys(t).length, defs.length); assert.deepEqual(Object.keys(t), defs.map(d => `mock__${d.name.replace('.', '_')}`))
  const outs = await Promise.all(['a', 'b', 'c'].map(x => run(t.mock__echo!, { text: x })))
  assert.deepEqual(outs.map(text), ['echo:a', 'echo:b', 'echo:c'])
  await toolsOf(s.server)
  assert.equal(methods(s).filter(m => m === 'tools/list').length, 2, '两页，只取了一轮')
})

test('老 server（2025-11-25）：discover 被拒 → initialize → initialized；之后的请求没有新协议的 _meta；缺 resultType 当 complete；握手里不声明任何能力', async () => {
  const s = open({ mode: 'legacy', instructions: 'legacy hello' }); const t = await toolsOf(s.server)
  assert.equal(text(await run(t.mock__echo!, { text: 'x' })), 'echo:x')
  assert.deepEqual(methods(s), ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  const init = s.received().find(m => m.method === 'initialize')!.params as Record<string, unknown>
  assert.deepEqual([init.protocolVersion, init.capabilities], ['2025-11-25', {}])
  for (const m of s.received().filter(m => m.method === 'tools/list' || m.method === 'tools/call')) assert.ok(!Object.keys((m.params as { _meta: object })._meta).some(k => k.startsWith(NS)), JSON.stringify(m))
  assert.equal(await s.server.instructions!(capabilityCtx), 'legacy hello')
})

test('旧协议 server 中途主动发来请求（elicitation/create）：我们没声明能力，回一个错误让它别等，调用本身不受影响', async () => {
  const s = open({ mode: 'legacy' }); const t = await toolsOf(s.server)
  assert.match(text(await run(t['mock__srv-request']!, {})), /client answered: This client does not handle server-initiated requests/)
})

test('对 discover 不作声的老 server：超时后回退到 initialize', async () => {
  const s = open({ mode: 'silent-legacy' }, { probeTimeoutMs: 300 }); const t = await toolsOf(s.server)
  assert.equal(text(await run(t.mock__echo!, { text: 'y' })), 'echo:y'); assert.ok(methods(s).includes('initialize'))
})

test('回退关掉时，老 server 是明确的错误；新 server 不受影响', async () => {
  const s = open({ mode: 'legacy' }, { fallback: false })
  await assert.rejects(toolsOf(s.server), (e: unknown) => e instanceof McpError && /fallback to 2025-11-25 is off/.test(e.message))
  assert.equal(methods(s).includes('initialize'), false)
})

test('版本不对（-32022）：用 server 报的 supported 换版本重发一次', async () => {
  const s = open({}, { versions: ['2099-01-01', '2026-07-28'] }); const t = await toolsOf(s.server)
  assert.equal(text(await run(t.mock__echo!, { text: 'v' })), 'echo:v')
  const versions = s.received().map(m => ((m.params as { _meta: Record<string, unknown> })._meta)[`${NS}protocolVersion`])
  assert.deepEqual(versions, ['2099-01-01', '2026-07-28', '2026-07-28', '2026-07-28'])
})

test('server 的 supported 里没有我们会说的版本：明确的错误（回退关了的话）', async () => {
  const s = open({ supported: ['2030-01-01'] }, { fallback: false })
  await assert.rejects(toolsOf(s.server), /supports \["2030-01-01"\]/)
})

test('server 不带 resultType（模拟没按新规范写的新协议 server）也能用', async () => {
  const t = await toolsOf(open({ noResultType: true }).server)
  assert.equal(text(await run(t.mock__echo!, { text: 'n' })), 'echo:n')
})

test('close()：关 stdin、等 server 退出；进程崩溃或被 kill 时也不留孤儿', async () => {
  const s = open(); await toolsOf(s.server); const pid = s.pid()
  assert.ok(alive(pid)); await s.server.close(); await until(() => !alive(pid), 3000)
})

test('起不来的命令：请求以明确的错误失败，不挂住', async () => {
  const client = createClient(stdioTransport('/nonexistent/hue-mcp-server', []))
  await assert.rejects(client.rpc('tools/list', {}, { signal: AbortSignal.timeout(3000) }), /could not start/)
})

test('名字不合法 / effects 覆盖 / 不信任 annotations', async () => {
  assert.throws(() => stdio({}, { name: 'Bad_Name' }), /lowercase/)
  const o = open({}, { effects: { write: 'idempotent' }, trustAnnotations: false }); const t = await toolsOf(o.server)
  assert.deepEqual([t.mock__echo!.effects, t.mock__write!.effects, t.mock__idem!.effects], ['unsafe', 'idempotent', 'unsafe'])
})

// ───── 每个适配出来的工具过 core 的合同 ─────
{
  const client = createClient(stdioTransport(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('./mcp-stdio-server.ts', import.meta.url).pathname, '{}']))
  after(() => client.close())
  for (const name of ['echo', 'write', 'idem', 'rich']) {
    toolContract(adapt(defs.find(d => d.name === name)! as never, client, { server: 'mock' }), { valid: name === 'echo' || name === 'write' ? { text: 'hi' } : {}, invalid: [] as never })
  }
}

test('不听话的 server（关了 stdin 也不退）：close() 升级到 SIGTERM；连 SIGTERM 也不理就升级到 SIGKILL', { timeout: 20_000 }, async () => {
  const a = stdio({ ignoreEof: true }); await toolsOf(a.server); const pa = a.pid()
  await a.server.close(); assert.equal(alive(pa), false); assert.ok(a.stderr.includes('got-sigterm'), '先是 SIGTERM')
  const b = stdio({ ignoreEof: true, ignoreTerm: true }); await toolsOf(b.server); const pb = b.pid()
  await b.server.close(); assert.ok(b.stderr.includes('got-sigterm')); assert.equal(alive(pb), false, 'SIGKILL 兜底')
})

test('宿主进程直接退出（没调 close）：不听话的 server 也被带走，不留孤儿', { timeout: 15_000 }, async () => {
  const out = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('./mcp-orphan.ts', import.meta.url).pathname], { encoding: 'utf8', timeout: 10_000 })
  const pid = Number(/pid:(\d+)/.exec(out)![1]); await until(() => !alive(pid), 3000)
})
