import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import type { HueEvent, Message, ModelChunk, ModelPort } from '@hue/core'
import { sqliteStore } from '@hue/store'
import { runAgent } from './agent.js'
import { docker, local } from '@hue/sandbox'

const tmp = () => mkdtempSync(join(tmpdir(), 'hue-ex-'))

// ═════════ 里程碑脚本，用脚本化的假模型 ═════════
const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 5, outputTokens: 5 } })
const call = (callId: string, name: string, input: object): ModelChunk => ({ type: 'tool-call', callId, name, input: input as never })
const text = (t: string): ModelChunk => ({ type: 'text-delta', text: t })

function scripted(steps: ModelChunk[][]): ModelPort & { requests: Message[][] } {
  let i = 0; const requests: Message[][] = []
  return {
    specVersion: 'hue.model.v1', id: 'mock:1', requests,
    info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(req) { requests.push(structuredClone(req.messages)); for (const c of steps[i++] ?? [text('(script exhausted)'), fin('stop')]) yield c },
  }
}

/** 一个有 bug 的小仓库：add 写成了减法，node test.js 会失败。 */
function buggyRepo() {
  const d = tmp()
  writeFileSync(join(d, 'calc.js'), 'exports.add = (a, b) => a - b\n')
  writeFileSync(join(d, 'test.js'), "const { add } = require('./calc.js')\nif (add(2, 3) !== 5) { console.error('add(2,3) =', add(2, 3)); process.exit(1) }\nconsole.log('ok')\n")
  return d
}
const all = async (db: string, sid: string) => { const s = sqliteStore(db); const a: HueEvent[] = []; for await (const e of s.read(sid)) a.push(e); s.close(); return a }

test('agent：读 → 改 → 跑测试 → 通过；bash 前问过人；整个过程落在 sqlite 日志里', async () => {
  const dir = buggyRepo(), db = join(tmp(), 'hue.db'), asked: string[] = []
  const model = scripted([
    [call('c1', 'bash', { command: 'node test.js' }), fin('tool-calls')],
    [call('c2', 'read', { path: 'calc.js' }), fin('tool-calls')],
    [call('c3', 'edit', { path: 'calc.js', old_string: 'a - b', new_string: 'a + b' }), fin('tool-calls')],
    [call('c4', 'bash', { command: 'node test.js' }), fin('tool-calls')],
    [text('把 add 里的减号改成了加号，测试通过。'), fin('stop')],
  ])
  const r = await runAgent({ model, sandbox: await local({ root: dir }), task: '修好 add', db, sessionId: 's1', ask: async p => { asked.push(p); return true } })
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 5)
  assert.equal(readFileSync(join(dir, 'calc.js'), 'utf8'), 'exports.add = (a, b) => a + b\n')
  assert.equal(asked.length, 2); assert.ok(asked.every(p => p.startsWith('bash ')), 'read / edit 不问，只有 bash 问')

  // 第一次 bash 的结果（测试失败）确实回到了模型手里
  const firstBash = model.requests[1]!.at(-1)!
  assert.ok(firstBash.role === 'tool' && JSON.stringify(firstBash).includes('add(2,3) = -1') && JSON.stringify(firstBash).includes('exit code 1'))
  // 日志：tool.call 在对应的 tool.result 之前；整个会话能 fold 回来
  const log = await all(db, 's1')
  assert.deepEqual(log.map(e => e.seq), log.map((_, i) => i + 1))
  assert.ok(log.findIndex(e => e.type === 'tool.call' && e.callId === 'c3') < log.findIndex(e => e.type === 'tool.result' && e.callId === 'c3'))
  assert.equal(log.at(-1)!.type, 'turn.ended')
})

test('agent：用户拒绝 bash → 命令没有执行，模型收到被拒绝的结果', async () => {
  const dir = tmp(), db = join(tmp(), 'hue.db')
  const model = scripted([[call('c1', 'bash', { command: 'touch pwned' }), fin('tool-calls')], [text('好的，不执行。'), fin('stop')]])
  const r = await runAgent({ model, sandbox: await local({ root: dir }), task: 'x', db, sessionId: 's', ask: async () => false })
  assert.equal(r.reason, 'stop'); assert.equal(existsSync(join(dir, 'pwned')), false)
  const result = JSON.stringify(model.requests[1]!.at(-1))
  assert.ok(/denied|declined/i.test(result), result)
})

test('agent：越界路径被 sandbox 拦住，模型收到错误而不是文件内容', async () => {
  const dir = tmp(), db = join(tmp(), 'hue.db')
  const model = scripted([[call('c1', 'read', { path: '../../../etc/passwd' }), fin('tool-calls')], [text('读不了。'), fin('stop')]])
  await runAgent({ model, sandbox: await local({ root: dir }), task: 'x', db, sessionId: 's', ask: async () => true })
  const result = JSON.stringify(model.requests[1]!.at(-1))
  assert.ok(result.includes('escapes the sandbox root') && !/root:[x*]:/.test(result), result)
})

test('agent：续写同一会话；上次死在工具执行中途 → 先补 crashed 结果，模型看得到历史', async () => {
  const dir = tmp(), db = join(tmp(), 'hue.db')
  // 模拟上一个进程：发出了 bash 调用（tool.call 已落盘），然后被 kill -9，没有 tool.result。
  const env = (seq: number) => ({ v: 1, id: `old${seq}`, sessionId: 's', seq, at: seq, turnId: 't0' })
  const s = sqliteStore(db)
  await s.append([
    { ...env(1), type: 'turn.started', turnId: 't0' },
    { ...env(2), type: 'user.message', message: { role: 'user', content: [{ type: 'text', text: '第一个任务' }] } },
    { ...env(3), type: 'step.started', step: 1 },
    { ...env(4), type: 'model.message', message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'dead', name: 'bash', input: { command: 'deploy' } }] }, modelId: 'mock:1', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 },
    { ...env(5), type: 'tool.call', callId: 'dead', name: 'bash', input: { command: 'deploy' }, effects: 'unsafe' },
  ] as HueEvent[]); s.close()

  const model = scripted([[text('我看到上次的 deploy 中断了。'), fin('stop')]])
  const r = await runAgent({ model, sandbox: await local({ root: dir }), task: '继续', db, sessionId: 's', ask: async () => true })
  assert.equal(r.reason, 'stop')
  const roles = model.requests[0]!.map(m => m.role)
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'user']) // 每个 tool-call 都有配对的 tool-result
  assert.match(JSON.stringify(model.requests[0]![2]), /crashed|unknown/i)
  const log = await all(db, 's')
  assert.deepEqual(log.map(e => e.seq), log.map((_, i) => i + 1))
})

const dockerUp = (() => { try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 }); return true } catch { return false } })()

test('agent 在 docker 里：bash 在容器内执行且不再逐条询问，edit 经挂载目录落到宿主上', { skip: dockerUp ? false : 'docker is not available', timeout: 90_000 }, async () => {
  const dir = tmp(), db = join(tmp(), 'hue.db'), asked: string[] = []
  writeFileSync(join(dir, 'greet.sh'), 'echo hello\n')
  const sandbox = await docker({ mount: dir, image: process.env.HUE_TEST_IMAGE ?? 'alpine:3' })
  try {
    const model = scripted([
      [call('c1', 'edit', { path: 'greet.sh', old_string: 'hello', new_string: 'hi' }), fin('tool-calls')],
      [call('c2', 'bash', { command: 'sh greet.sh; id -u; pwd' }), fin('tool-calls')],
      [text('done'), fin('stop')],
    ])
    const r = await runAgent({ model, sandbox, task: 'x', db, sessionId: 's', confirmUnsafe: false, ask: async p => { asked.push(p); return true } })
    assert.equal(r.reason, 'stop'); assert.deepEqual(asked, [])
    assert.equal(readFileSync(join(dir, 'greet.sh'), 'utf8'), 'echo hi\n')
    const out = JSON.stringify(model.requests[2]!.at(-1))
    assert.ok(out.includes('hi\\n') && out.includes('/work') && !out.includes('\\n0\\n'), out) // 在容器里执行、不是 root
  } finally { await sandbox.dispose() }
})
