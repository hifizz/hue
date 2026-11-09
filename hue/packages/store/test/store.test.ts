import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyState, fold, isDurable, runTurn, textResult, userText } from '@hue/core'
import type { EventStore, HueEvent, ModelChunk, ModelPort, Tool } from '@hue/core'
import { eventStoreContract } from '@hue/core/contracts'
import { listSessions, memoryStore, sqliteStore } from '../src/index.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'hue-store-')), 'hue.db')
const all = async <T>(it: AsyncIterable<T>) => { const a: T[] = []; for await (const x of it) a.push(x); return a }
const ev = (sessionId: string, seq: number, extra: object = {}): HueEvent =>
  ({ v: 1, id: `${sessionId}-${seq}`, sessionId, seq, at: seq * 10, type: 'turn.started', turnId: 't', ...extra }) as HueEvent

// ═════════ 合同：两个实现都要过 ═════════
eventStoreContract('memory', async () => memoryStore())
eventStoreContract('sqlite', async () => sqliteStore(':memory:'))

// ═════════ 两个实现的共同行为 ═════════
for (const [name, make] of [['memory', () => memoryStore()], ['sqlite', () => sqliteStore(':memory:')]] as const) {
  test(`${name}: 失败的批次不留痕迹；跨会话的批次也是原子的`, async () => {
    const s = make()
    await s.append([ev('a', 1)])
    await assert.rejects(s.append([ev('a', 2), ev('b', 1), ev('b', 3)]), /expected seq 2, got 3|expected seq 2/)
    assert.equal(await s.lastSeq('a'), 1); assert.equal(await s.lastSeq('b'), 0)
    await s.append([ev('a', 2), ev('b', 1)]) // 同一批里可以混多个会话，各自连续即可
    assert.deepEqual([await s.lastSeq('a'), await s.lastSeq('b')], [2, 1])
  })

  test(`${name}: 同一批里 seq 必须连续；错误信息说明期望值；空批次无害`, async () => {
    const s = make()
    await assert.rejects(s.append([ev('a', 1), ev('a', 1)]), /expected seq 2, got 1/)
    await assert.rejects(s.append([ev('a', 2)]), /expected seq 1, got 2/)
    await s.append([])
    assert.equal(await s.lastSeq('a'), 0)
  })

  test(`${name}: 三种临时事件都被拒绝，durable 的 ext 可以存`, async () => {
    const s = make()
    for (const e of [{ type: 'model.delta', kind: 'text', delta: 'x' }, { type: 'tool.input.delta', callId: 'c', name: 'n', delta: '{' }, { type: 'tool.progress', callId: 'c', data: 1 }])
      await assert.rejects(s.append([ev('a', 1, e)]), /ephemeral/, e.type)
    await assert.rejects(s.append([ev('a', 1, { type: 'ext', durable: false, name: 'x', data: null })]), /ephemeral/)
    await s.append([ev('a', 1, { type: 'ext', durable: true, name: 'x', data: { n: 1 } })])
    assert.equal(await s.lastSeq('a'), 1)
  })

  test(`${name}: 读出来的是副本，改它不影响日志；fromSeq 超过末尾得到空`, async () => {
    const s = make()
    await s.append([ev('a', 1, { note: 'orig' })])
    ;((await all(s.read('a')))[0] as { note?: string }).note = 'changed'
    assert.equal(((await all(s.read('a')))[0] as { note?: string }).note, 'orig')
    assert.deepEqual(await all(s.read('a', { fromSeq: 9 })), [])
    assert.deepEqual(await all(s.read('nope')), [])
  })

  test(`${name}: listSessions：lastSeq、updatedAt、子会话的 parent`, async () => {
    const s = make()
    const parent = { sessionId: 'a', turnId: 't1', callId: 'c1' }
    await s.append([ev('a', 1), ev('a', 2), ev('b', 1, { type: 'session.created', parent })])
    const got = (await all(listSessions(s))).sort((x, y) => x.sessionId.localeCompare(y.sessionId))
    assert.deepEqual(got, [{ sessionId: 'a', lastSeq: 2, updatedAt: 20 }, { sessionId: 'b', lastSeq: 1, updatedAt: 10, parent }])
  })

  test(`${name}: 与真 core 的 runTurn 配合：边拉边写，结束后 fold(read) 等于 turn 的 state`, async () => {
    const s = make()
    const echo: Tool = { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, effects: 'none', async execute(i) { return textResult(`echo:${JSON.stringify(i)}`) } }
    const script: ModelChunk[][] = [
      [{ type: 'text-delta', text: '我来查' }, { type: 'tool-call', callId: 'c1', name: 'echo', input: { q: 1 } }, { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } }],
      [{ type: 'text-delta', text: '好了' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } }],
    ]
    let i = 0
    const model: ModelPort = { specVersion: 'hue.model.v1', id: 'mock:1', info: { contextWindow: 1000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
      async *stream() { for (const c of script[i++]!) yield c } }
    const g = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('hi'), model, tools: [echo] })
    let result
    while (true) {
      const n = await g.next()
      if (n.done) { result = n.value; break }
      if (isDurable(n.value)) await s.append([n.value]) // 拉取即落盘：下一次 next() 之前先写
    }
    assert.equal(result.reason, 'stop')
    // 经过 JSON 之后值为 undefined 的字段（providerMetadata: undefined 之类）会消失，语义不变，所以两边都规整一下再比。
    const json = (x: unknown) => JSON.parse(JSON.stringify(x))
    assert.deepEqual(json(fold('s', await all(s.read('s')))), json(result.state))
  })
}

// ═════════ sqlite 特有 ═════════

test('sqlite：关闭后重新打开，事件、lastSeq 和 listSessions 都在', async () => {
  const p = tmp()
  const a = sqliteStore(p); await a.append([ev('a', 1), ev('a', 2)]); a.close()
  const b = sqliteStore(p)
  assert.deepEqual((await all(b.read('a'))).map(e => e.seq), [1, 2]); assert.equal(await b.lastSeq('a'), 2)
  await b.append([ev('a', 3)]); assert.equal(await b.lastSeq('a'), 3) // 续写同一会话
  assert.deepEqual(await all(listSessions(b)), [{ sessionId: 'a', lastSeq: 3, updatedAt: 30 }])
  b.close()
})

test('sqlite：两个连接写同一会话，后到的因 seq 对不上被拒绝，而不是交错', async () => {
  const p = tmp(); const a = sqliteStore(p), b = sqliteStore(p)
  await a.append([ev('a', 1)])
  await assert.rejects(b.append([ev('a', 1)]), /expected seq 2, got 1/) // b 没有缓存 lastSeq，每次都问库
  await b.append([ev('a', 2)])
  assert.deepEqual((await all(a.read('a'))).map(e => e.seq), [1, 2]); a.close(); b.close()
})

test('sqlite：分页读取跨页边界不丢不重（1234 条，页大小 500）', async () => {
  const s = sqliteStore(':memory:')
  for (let i = 0; i < 1234; i += 200) await s.append(Array.from({ length: Math.min(200, 1234 - i) }, (_, k) => ev('a', i + k + 1)))
  assert.deepEqual((await all(s.read('a'))).map(e => e.seq), Array.from({ length: 1234 }, (_, i) => i + 1))
  assert.deepEqual((await all(s.read('a', { fromSeq: 500 }))).map(e => e.seq).slice(0, 3), [500, 501, 502])
  assert.equal((await all(s.read('a', { fromSeq: 1001 }))).length, 234)
})

test('sqlite：边读边写不互相干扰（读到一半时追加）', async () => {
  const s = sqliteStore(':memory:')
  await s.append(Array.from({ length: 600 }, (_, i) => ev('a', i + 1)))
  const seen: number[] = []; let wrote = false
  for await (const e of s.read('a')) { seen.push(e.seq); if (!wrote) { wrote = true; await s.append([ev('a', 601)]) } }
  assert.deepEqual(seen, Array.from({ length: 601 }, (_, i) => i + 1)) // 第二页读到了中途追加的那条，且没有重复
})

test('sqlite：事件原样存放（含 v 和未知字段）；坏掉的行读取时报出位置', async () => {
  const p = tmp(); const s = sqliteStore(p)
  await s.append([ev('a', 1, { v: 7, future: { x: [1, 2] } })])
  assert.deepEqual((await all(s.read('a')))[0], ev('a', 1, { v: 7, future: { x: [1, 2] } }))
  s.close()
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(p); raw.exec(`UPDATE events SET body_json = '{oops' WHERE seq = 1`); raw.close()
  const again = sqliteStore(p)
  await assert.rejects(all(again.read('a')), /corrupt event body at session a seq 1/); again.close()
})

test('sqlite：事件不能序列化 → append 失败且整批回滚', async () => {
  const s = sqliteStore(':memory:')
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  await assert.rejects(s.append([ev('a', 1), ev('a', 2, { cyclic })]))
  assert.equal(await s.lastSeq('a'), 0)
  await s.append([ev('a', 1)]) // 回滚后事务状态是干净的，可以继续用
})

// ═════════ 招牌测试：kill -9 ═════════

test('kill -9：子进程边写边被 SIGKILL，重启后读到的是前缀——已确认的全在、seq 连续、没有半条', { timeout: 60_000 }, async () => {
  const writer = join(import.meta.dirname, 'kill-writer.ts')
  for (const [round, batch] of [[1, 1], [2, 7], [3, 50]] as const) {
    const p = tmp()
    const child = spawn(process.execPath, ['--import', 'tsx', writer, p, String(batch)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let acked = 0, buf = ''
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.stdout.on('data', d => {
        buf += d; const lines = buf.split('\n'); buf = lines.pop()!
        for (const l of lines) acked = Number(l)
        if (acked >= batch * 30) { child.kill('SIGKILL') } // 写了一阵之后在随机的时刻杀掉
      })
      child.on('exit', () => resolve())
    })
    assert.ok(acked >= batch * 30, `round ${round}: writer never got going (acked ${acked})`)

    const s = sqliteStore(p)
    const got = await all(s.read('k'))
    // 1. 连续：没有洞、没有重复
    assert.deepEqual(got.map(e => e.seq), Array.from({ length: got.length }, (_, i) => i + 1), `round ${round}`)
    // 2. 已确认的一条不少（append 返回 = 已落盘）；最多多出"杀死时正在写的那一批"
    assert.ok(got.length >= acked, `round ${round}: lost acknowledged events: have ${got.length}, acked ${acked}`)
    assert.ok(got.length <= acked + 2 * batch + 1, `round ${round}: too many: ${got.length} vs acked ${acked}`)
    // 3. 批是原子的：总数是批大小的整数倍（我们每批 batch 条）
    assert.equal(got.length % batch, 0, `round ${round}: partial batch survived (${got.length} % ${batch})`)
    // 4. 能续写：重启后接着往下写
    await s.append([ev('k', got.length + 1)]); assert.equal(await s.lastSeq('k'), got.length + 1); s.close()
  }
})

test('kill -9 之后日志里留着 -wal 文件也能正常读（恢复由 sqlite 完成）', () => {
  // 说明性测试：确认 WAL 模式确实开着，kill 测试才有意义。
  const p = tmp(); const s = sqliteStore(p); s.close()
  assert.ok(readFileSync(p).subarray(18, 20).equals(Buffer.from([2, 2]))) // 文件头第 18、19 字节 = 2 表示 WAL
})
