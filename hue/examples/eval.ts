/**
 * 评测脚本：把内置的 5 个小仓库任务交给 agent 跑，出报告（成功率、token、耗时、失败案例）。
 *
 *   cd hue && npx tsx --env-file=.env.local examples/eval.ts [--tasks a,b] [--trials 3] [--concurrency 2] [--out eval-report]
 *
 * 每次试跑在一个新的临时目录里，默认在 Docker 容器里（HUE_SANDBOX=docker，镜像 HUE_IMAGE，网络 HUE_NETWORK）。
 * local 模式不隔离，且没人可以问：策略是 presets.yolo()，等于让模型以你的身份随便跑命令，只在你清楚后果时用。
 * 每次试跑的完整事件日志写在 HUE_DB（默认 ./eval.db），会话 id 在报告里，examples/replay.ts 可以看时间线。
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ContextStrategy, ModelPort, PolicyPort } from '@hue/core'
import { chain, foldToolResults, summarize } from '@hue/context'
import { codingTasks, formatReport, runEval, summarize as summarizeRuns } from '@hue/eval'
import type { AgentJob, AgentRunner } from '@hue/eval'
import { presets } from '@hue/policy'
import { docker, local } from '@hue/sandbox'
import { modelFromEnv, runAgent } from './agent.js'

export interface AgentRunnerOptions {
  /** 每次试跑一个模型（脚本化的假模型是有状态的，不能共用）。 */
  model(job: AgentJob): ModelPort
  db: string
  policy: PolicyPort
  context?: (model: ModelPort) => ContextStrategy
}

/** 把 examples/agent.ts 的 runAgent 接成 eval 的 AgentRunner。没人可问，需要确认的一律拒绝。 */
export function agentRunner(o: AgentRunnerOptions): AgentRunner {
  return async job => {
    const model = o.model(job)
    await runAgent({ model, sandbox: job.sandbox, task: job.task.prompt, db: o.db, sessionId: job.sessionId, policy: o.policy, context: o.context?.(model), ask: async () => false, onEvent: job.onEvent, signal: job.signal })
  }
}

const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.env.HUE_SANDBOX ?? 'docker'
  if (mode !== 'docker' && mode !== 'local') { console.error(`HUE_SANDBOX 只能是 docker 或 local，收到 "${mode}"`); process.exit(2) }
  const want = flag('tasks')?.split(',')
  const tasks = codingTasks().filter(t => !want || want.includes(t.id))
  if (!tasks.length) { console.error(`没有匹配的任务。可选：${codingTasks().map(t => t.id).join(', ')}`); process.exit(2) }
  const out = flag('out') ?? 'eval-report'
  const ac = new AbortController(); process.once('SIGINT', () => ac.abort())

  const results = await runEval(tasks, {
    run: agentRunner({ model: () => modelFromEnv(), db: process.env.HUE_DB ?? './eval.db', policy: presets.yolo(), context: m => chain(foldToolResults(), summarize({ model: m })) }),
    sandbox: async dir => (mode === 'docker' ? docker({ mount: dir, image: process.env.HUE_IMAGE, network: process.env.HUE_NETWORK }) : local({ root: dir })),
    trials: Number(flag('trials') ?? 1), concurrency: Number(flag('concurrency') ?? 1), signal: ac.signal,
    onResult: r => console.log(`${r.status === 'pass' ? '✓' : '✗'} ${r.taskId} #${r.trial}  ${r.status}${r.layer ? `/${r.layer}` : ''}  ${r.metrics.steps} 步  ${(r.metrics.durationMs / 1000).toFixed(1)}s${r.detail && r.status !== 'pass' ? `  ${r.detail.slice(0, 100).replace(/\s+/g, ' ')}` : ''}`),
  })
  const report = summarizeRuns(results)
  const md = formatReport(report, { title: 'Hue eval：内置编码任务', model: process.env.HUE_MODEL ?? 'claude-sonnet-5-5' })
  writeFileSync(`${out}.md`, md); writeFileSync(`${out}.json`, JSON.stringify(report, null, 2))
  console.log(`\n${md}\n报告：${out}.md / ${out}.json`)
  process.exit(report.passes === report.trials ? 0 : 1)
}
