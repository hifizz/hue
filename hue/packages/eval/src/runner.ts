import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDurable } from '@hue/core'
import type { HueEvent } from '@hue/core'
import { layerOf, metricsOf } from './metrics.js'
import type { AgentRunner, EvalSandbox, EvalTask, Status, TrialResult } from './types.js'

export interface EvalOptions {
  run: AgentRunner
  /** 每次试跑一个新的执行环境（挂载这次的工作目录）。有 dispose 就在结束时调用。 */
  sandbox(dir: string, signal: AbortSignal): Promise<EvalSandbox>
  /** 每个任务跑几次，默认 1。模型有随机性，想看稳定性就多跑。 */
  trials?: number
  /** 同时跑几个试跑，默认 1。 */
  concurrency?: number
  /** agent 最长跑多久，默认 10 分钟；任务自己的 timeoutMs 优先。超时算 timeout，不再跑 check。 */
  timeoutMs?: number
  /** 工作目录什么时候留下：默认只留没通过的，方便去看现场。 */
  keep?: 'failed' | 'all' | 'none'
  signal?: AbortSignal
  onResult?(r: TrialResult): void
  /** 会话 id 的前缀，默认用开始时间。 */
  runId?: string
  now?(): number
}

export async function runEval(tasks: EvalTask[], o: EvalOptions): Promise<TrialResult[]> {
  const runId = o.runId ?? new Date().toISOString().replace(/\W/g, '').slice(0, 14)
  const jobs = tasks.flatMap(task => Array.from({ length: o.trials ?? 1 }, (_, i) => ({ task, trial: i + 1 })))
  const results: Array<TrialResult | undefined> = new Array(jobs.length)
  let next = 0
  const worker = async () => {
    while (next < jobs.length && !o.signal?.aborted) {
      const k = next++
      const r = await trial(jobs[k]!.task, jobs[k]!.trial, runId, o)
      results[k] = r; o.onResult?.(r)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 1, jobs.length)) }, worker))
  return results.filter((r): r is TrialResult => !!r)
}

async function trial(task: EvalTask, n: number, runId: string, o: EvalOptions): Promise<TrialResult> {
  const now = o.now ?? Date.now
  const sessionId = `eval-${runId}-${task.id}-${n}`
  const dir = await mkdtemp(join(tmpdir(), 'hue-eval-'))
  const events: HueEvent[] = []
  const ac = new AbortController()
  const signal = o.signal ? AbortSignal.any([ac.signal, o.signal]) : ac.signal
  let timedOut = false, status: Status = 'error', detail: string | undefined, sandbox: EvalSandbox | undefined, durationMs = 0
  try {
    await task.setup(dir)
    sandbox = await o.sandbox(dir, signal)
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, task.timeoutMs ?? o.timeoutMs ?? 600_000)
    const t0 = now()
    try { await o.run({ task, dir, sessionId, sandbox, signal, onEvent: e => { if (isDurable(e)) events.push(e) } }) }
    finally { clearTimeout(timer); durationMs = now() - t0 }
    if (timedOut) { status = 'timeout'; detail = 'agent did not finish in time' }
    else if (o.signal?.aborted) detail = 'eval was cancelled'
    else { const s = await task.check({ dir, sandbox, events, signal: o.signal ?? new AbortController().signal }); status = s.pass ? 'pass' : 'fail'; detail = s.detail }
  } catch (e) {
    if (timedOut) { status = 'timeout'; detail = 'agent did not finish in time' }
    else { status = 'error'; detail = e instanceof Error ? e.message : String(e) }
  } finally {
    try { await sandbox?.dispose?.() } catch { /* 清理失败不改变结果 */ }
  }
  const keepDir = o.keep === 'all' || (o.keep !== 'none' && status !== 'pass')
  if (!keepDir) await rm(dir, { recursive: true, force: true })
  return { taskId: task.id, tags: task.tags ?? [], trial: n, sessionId, status, detail, layer: layerOf(status, events), metrics: metricsOf(events, durationMs), events, ...(keepDir && { dir }) }
}
