import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HueEvent } from '@hue/core'
import { codingTasks, formatReport, layerOf, metricsOf, runEval, summarize, tail } from '../src/index.js'
import type { AgentRunner, EvalTask, TrialResult } from '../src/index.js'
import { ev, hostSandbox } from './helpers.js'

// ═════════ 内置任务自检：题目本身得是对的 ═════════

const check = async (t: EvalTask, dir: string) => t.check({ dir, sandbox: hostSandbox(dir), events: [], signal: new AbortController().signal })
const fresh = async (t: EvalTask) => { const dir = await mkdtemp(join(tmpdir(), 'hue-evtest-')); await t.setup(dir); return dir }

test('内置任务：初始状态不通过，已知的正确改法通过', async () => {
  const tasks = codingTasks()
  assert.deepEqual(tasks.map(t => t.id), ['fix-off-by-one', 'fix-missing-await', 'fix-wrong-name', 'add-slugify', 'change-one-of-many'])
  assert.equal(new Set(tasks.map(t => t.id)).size, tasks.length)
  for (const t of tasks) {
    const dir = await fresh(t)
    try {
      const before = await check(t, dir)
      assert.equal(before.pass, false, `${t.id} must fail before the fix: ${before.detail}`)
      for (const [p, body] of Object.entries(t.solution)) await writeFile(join(dir, p), body)
      const after = await check(t, dir)
      assert.equal(after.pass, true, `${t.id} must pass after the fix: ${after.detail}`)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('判分前测试文件被原样写回：改测试蒙混过关没用', async () => {
  const t = codingTasks()[0]!; const dir = await fresh(t)
  await writeFile(join(dir, 'test.js'), "console.log('ok')\n") // 作弊：把测试改成什么都不测
  const r = await check(t, dir)
  assert.equal(r.pass, false); assert.match(r.detail ?? '', /AssertionError|Expected/)
  assert.match(await readFile(join(dir, 'test.js'), 'utf8'), /sumTo\(4\)/)
})

test('change-one-of-many：顺手改了别的模块也不通过', async () => {
  const t = codingTasks().find(x => x.id === 'change-one-of-many')!; const dir = await fresh(t)
  for (const [p, body] of Object.entries(t.solution)) await writeFile(join(dir, p), body)
  await writeFile(join(dir, 'modules/m07.js'), "exports.name = 'm07'\nexports.timeoutMs = 60000\n")
  const r = await check(t, dir)
  assert.equal(r.pass, false); assert.match(r.detail ?? '', /m07 must not change/)
})

// ═════════ metrics / layerOf ═════════

test('metrics：步数、token（含缓存）、工具调用与失败、被拒、压缩，全部来自事件', () => {
  const events = [ev.turn(), ev.model('', ev.usage(100, 20, 300), 'tool-calls'), ev.call('a'), ev.result('a', 'boom', true), ev.call('b'), ev.result('b', 'no', true, 'denied'),
    ev.compacted(), ev.model('half', ev.usage(0, 0), 'aborted'), ev.model('done', ev.usage(50, 10)), ev.end('stop')]
  assert.deepEqual(metricsOf(events, 1234), { steps: 2, inputTokens: 450, cacheReadTokens: 300, outputTokens: 30, toolCalls: 2, toolErrors: 2, denied: 1, compactions: 1, durationMs: 1234, endReason: 'stop' })
})

test('layerOf：通过没有层；评测自己出错是 harness；超时；按 turn 的结束原因分层', () => {
  assert.equal(layerOf('pass', [ev.end('stop')]), undefined)
  assert.equal(layerOf('error', []), 'harness'); assert.equal(layerOf('timeout', []), 'timeout')
  assert.equal(layerOf('fail', []), 'interrupted')
  assert.equal(layerOf('fail', [ev.end('error', { code: 'model_error', message: 'x' })]), 'model')
  assert.equal(layerOf('fail', [ev.end('error', { code: 'context_overflow', message: 'x' })]), 'context')
  assert.equal(layerOf('fail', [ev.end('stop_condition')]), 'step-limit'); assert.equal(layerOf('fail', [ev.end('length')]), 'output-limit')
  assert.equal(layerOf('fail', [ev.end('interrupted')]), 'interrupted')
  assert.equal(layerOf('fail', [ev.call('a'), ev.result('a'), ev.end('stop')]), 'wrong-result')
  const bad = ['1', '2', '3', '4'].flatMap(i => [ev.call(i), ev.result(i, 'err', true)])
  assert.equal(layerOf('fail', [...bad, ev.end('stop')]), 'tools')
})

// ═════════ runEval ═════════

const task = (id: string, over: Partial<EvalTask> = {}): EvalTask =>
  ({ id, tags: ['t'], prompt: `do ${id}`, setup: async dir => { await writeFile(join(dir, 'seed'), id) }, check: async () => ({ pass: true }), ...over })
const sandbox = (log: string[] = []) => async (dir: string) => hostSandbox(dir, log)
const emit = (...es: HueEvent[]): AgentRunner => async job => { for (const e of es) job.onEvent(e) }

test('通过 / 没通过 / 评测出错：状态、层、指标、工作目录的去留', async () => {
  const log: string[] = []
  const rs = await runEval([task('ok'), task('bad', { check: async () => ({ pass: false, detail: 'expected 5' }) }), task('broken', { setup: async () => { throw new Error('disk full') } })],
    { run: emit(ev.turn(), ev.model('done', ev.usage(10, 5)), ev.end('stop')), sandbox: sandbox(log), runId: 'r1' })
  try {
    assert.deepEqual(rs.map(r => [r.taskId, r.status, r.layer]), [['ok', 'pass', undefined], ['bad', 'fail', 'wrong-result'], ['broken', 'error', 'harness']])
    assert.equal(rs[0]!.sessionId, 'eval-r1-ok-1'); assert.equal(rs[0]!.metrics.steps, 1); assert.equal(rs[1]!.detail, 'expected 5'); assert.match(rs[2]!.detail!, /disk full/)
    assert.equal(rs[0]!.dir, undefined, '通过的工作目录删掉'); assert.ok(rs[1]!.dir && existsSync(rs[1]!.dir), '没通过的留着看现场')
    assert.deepEqual(log, ['dispose', 'dispose'], 'setup 失败时没起沙箱，也就没有 dispose；其余每次都 dispose')
  } finally { for (const r of rs) if (r.dir) await rm(r.dir, { recursive: true, force: true }) }
})

test('keep：all 全留，none 全删', async () => {
  const run = emit(ev.end('stop'))
  const all = await runEval([task('a')], { run, sandbox: sandbox(), keep: 'all' }); assert.ok(all[0]!.dir && existsSync(all[0]!.dir))
  const none = await runEval([task('b', { check: async () => ({ pass: false }) })], { run, sandbox: sandbox(), keep: 'none' }); assert.equal(none[0]!.dir, undefined)
  await rm(all[0]!.dir!, { recursive: true, force: true })
})

test('trials：每个任务跑 n 次，会话 id 各不相同；check 拿到的是 durable 事件，临时事件不留', async () => {
  const seen: number[] = []
  const delta = { ...ev.turn(), type: 'model.delta', kind: 'text', delta: 'x' } as unknown as HueEvent
  const rs = await runEval([task('a', { check: async c => { seen.push(c.events.length); return { pass: true } } }), task('b')], { run: emit(ev.turn(), delta, ev.end('stop')), sandbox: sandbox(), trials: 3 })
  assert.deepEqual(rs.map(r => `${r.taskId}#${r.trial}`), ['a#1', 'a#2', 'a#3', 'b#1', 'b#2', 'b#3'])
  assert.equal(new Set(rs.map(r => r.sessionId)).size, 6); assert.deepEqual(seen, [2, 2, 2])
})

test('超时：agent 被打断、算 timeout、不再跑 check；任务自己的 timeoutMs 优先', async () => {
  let checked = false; const log: string[] = []
  const hang: AgentRunner = job => new Promise((_, rej) => job.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  const rs = await runEval([task('slow', { timeoutMs: 40, check: async () => { checked = true; return { pass: true } } })], { run: hang, sandbox: sandbox(log), timeoutMs: 60_000 })
  assert.equal(rs[0]!.status, 'timeout'); assert.equal(rs[0]!.layer, 'timeout'); assert.equal(checked, false); assert.deepEqual(log, ['dispose'])
  assert.ok(rs[0]!.metrics.durationMs >= 30 && rs[0]!.metrics.durationMs < 5000)
  // agent 自己捕获了中止、正常返回，同样算超时
  const polite: AgentRunner = job => new Promise(res => job.signal.addEventListener('abort', () => res()))
  assert.equal((await runEval([task('s2', { timeoutMs: 30 })], { run: polite, sandbox: sandbox() }))[0]!.status, 'timeout')
})

test('runner 抛错是 error（评测的问题），不是 fail；check 抛错也是', async () => {
  const boom: AgentRunner = async () => { throw new Error('docker is not running') }
  const a = (await runEval([task('a')], { run: boom, sandbox: sandbox() }))[0]!
  assert.equal(a.status, 'error'); assert.match(a.detail!, /docker is not running/)
  const b = (await runEval([task('b', { check: async () => { throw new Error('check blew up') } })], { run: emit(ev.end('stop')), sandbox: sandbox() }))[0]!
  assert.equal(b.status, 'error'); assert.match(b.detail!, /check blew up/)
})

test('concurrency：同时最多跑 n 个；结果顺序仍是任务顺序；onResult 每个都收到', async () => {
  let running = 0, max = 0; const got: string[] = []
  const run: AgentRunner = async job => { max = Math.max(max, ++running); await new Promise(r => setTimeout(r, 20)); running--; job.onEvent(ev.end('stop')) }
  const rs = await runEval(['a', 'b', 'c', 'd', 'e'].map(i => task(i)), { run, sandbox: sandbox(), concurrency: 2, onResult: r => got.push(r.taskId) })
  assert.equal(max, 2); assert.deepEqual(rs.map(r => r.taskId), ['a', 'b', 'c', 'd', 'e']); assert.equal(got.length, 5)
})

test('取消：已开始的这次标 error，没开始的不再跑', async () => {
  const ac = new AbortController(); let started = 0
  const run: AgentRunner = async () => { started++; ac.abort() }
  const rs = await runEval([task('a'), task('b'), task('c')], { run, sandbox: sandbox(), signal: ac.signal })
  assert.equal(started, 1); assert.deepEqual(rs.map(r => [r.taskId, r.status]), [['a', 'error']]); assert.match(rs[0]!.detail!, /cancelled/)
})

// ═════════ 报告 ═════════

const trial = (taskId: string, n: number, status: TrialResult['status'], events: HueEvent[], detail?: string, tags = ['t']): TrialResult =>
  ({ taskId, tags, trial: n, sessionId: `s-${taskId}-${n}`, status, detail, layer: layerOf(status, events), metrics: metricsOf(events, 1000 * n), events })
const win = (i = 100) => [ev.model('ok', ev.usage(i, 10)), ev.end('stop')]

test('summarize：成功率、token、中位数、按标签、按层；失败案例优先覆盖不同任务', () => {
  const rs = [
    trial('a', 1, 'pass', win(100), undefined, ['bugfix']), trial('a', 2, 'pass', win(300), undefined, ['bugfix']), trial('a', 3, 'fail', [ev.call('x'), ev.result('x', 'nope'), ev.end('stop')], 'expected 5', ['bugfix']),
    trial('b', 1, 'fail', [ev.end('error', { code: 'model_error', message: 'overloaded' })], 'x', ['feature']), trial('b', 2, 'error', [], 'docker down', ['feature']),
    trial('c', 1, 'timeout', [], undefined, ['feature']),
  ]
  const r = summarize(rs, { failures: 3 })
  assert.equal(r.trials, 6); assert.equal(r.passes, 2); assert.equal(r.errors, 1)
  assert.equal(r.inputTokens, 400); assert.equal(r.outputTokens, 20)
  assert.deepEqual(r.byTask.map(t => [t.id, t.passes, t.trials]), [['a', 2, 3], ['b', 0, 2], ['c', 0, 1]])
  assert.equal(r.byTask[0]!.tokens, 110) // 三次试跑 110、310、0 的中位数
  assert.deepEqual(r.byTag, [{ tag: 'bugfix', trials: 3, passes: 2 }, { tag: 'feature', trials: 3, passes: 0 }])
  assert.deepEqual(r.byLayer, { 'wrong-result': 1, model: 1, harness: 1, timeout: 1 })
  assert.deepEqual(r.failures.map(f => `${f.taskId}#${f.trial}`), ['a#3', 'b#1', 'c#1'], '每个任务各一个，不是 a#3 b#1 b#2')
  assert.deepEqual(r.failures[0]!.tail.slice(0, 2), ['▶ bash {}', '✓ bash nope'])
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, '报告可以直接存成 JSON')
})

test('summarize：中位数按试跑算（a 的两次通过分别用 110 和 310 token，加上失败那次 0，中位是 110）', () => {
  const r = summarize([trial('a', 1, 'pass', win(100)), trial('a', 2, 'pass', win(300)), trial('a', 3, 'fail', [ev.end('stop')])])
  assert.equal(r.byTask[0]!.tokens, 110); assert.equal(r.byTask[0]!.durationMs, 2000)
})

test('summarize：failures 上限；不够的用同一任务的其他次补；没有失败就没有案例', () => {
  const rs = [trial('a', 1, 'fail', [ev.end('stop')]), trial('a', 2, 'fail', [ev.end('stop')]), trial('a', 3, 'fail', [ev.end('stop')])]
  assert.deepEqual(summarize(rs, { failures: 2 }).failures.map(f => f.trial), [1, 2])
  assert.equal(summarize([trial('a', 1, 'pass', win())]).failures.length, 0)
  assert.equal(summarize([]).trials, 0)
})

test('tail：只留最后 n 行的摘要，长文本截断，临时事件不出现', () => {
  const long = 'x'.repeat(500)
  const lines = tail([ev.turn(), ev.model(long), ev.call('a', 'edit', { path: 'f' }), ev.result('a', long, true), ev.compacted(), ev.end('error', { code: 'model_error', message: 'overloaded' })], 4)
  assert.equal(lines.length, 4); assert.ok(lines.every(l => l.length < 160))
  assert.equal(lines.at(-1), '结束: error model_error: overloaded'); assert.ok(lines[1]!.startsWith('✗ bash'))
})

test('formatReport：标题、成功率、表格、分层、失败案例（含现场路径）；有评测错误时发出警告；全部通过时没有失败一节', () => {
  const rs = [trial('a', 1, 'pass', win(), undefined, ['bugfix']), { ...trial('b', 1, 'fail', [ev.call('x'), ev.result('x'), ev.end('stop')], 'expected 5'), dir: '/tmp/hue-eval-xyz' }, trial('c', 1, 'error', [], 'docker down')]
  const md = formatReport(summarize(rs), { title: 'demo', model: 'claude-x' })
  for (const s of ['# demo', '模型 claude-x', '成功 1/3（33%）', '| a | 1/1 |', '## 按标签', 'wrong-result 1', '### 1. b #1 — fail / wrong-result', '检查结果：expected 5', '`/tmp/hue-eval-xyz`', '▶ bash {}', '评测自己出了问题']) assert.ok(md.includes(s), `missing: ${s}\n${md}`)
  const clean = formatReport(summarize([trial('a', 1, 'pass', win())]))
  assert.ok(!clean.includes('失败案例') && !clean.includes('⚠'))
})
