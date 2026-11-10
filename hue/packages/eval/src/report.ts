import type { HueEvent } from '@hue/core'
import type { Metrics, Status, TrialResult } from './types.js'

export interface TaskRow { id: string; tags: string[]; trials: number; passes: number; steps: number; tokens: number; durationMs: number }
export interface Failure { taskId: string; trial: number; status: Status; layer?: string; detail?: string; sessionId: string; dir?: string; tail: string[] }
export interface Report {
  trials: number
  passes: number
  /** 评测自己出问题的试跑数（不是 agent 的错）。不为 0 时成功率不可信，先修了再跑。 */
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  durationMs: number
  byTask: TaskRow[]
  byTag: Array<{ tag: string; trials: number; passes: number }>
  byLayer: Record<string, number>
  failures: Failure[]
  runs: Array<{ taskId: string; trial: number; status: Status; layer?: string; metrics: Metrics }>
}

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0 }

/** 最后几个事件的一行行摘要，看一眼就知道它死前在干什么。 */
export function tail(events: HueEvent[], n = 10): string[] {
  const lines = events.flatMap((e): string[] => {
    switch (e.type) {
      case 'tool.call': return [`▶ ${e.name} ${clip(JSON.stringify(e.input), 90)}`]
      case 'tool.result': return [`${e.isError ? '✗' : '✓'} ${e.name} ${clip(e.content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join(''), 90)}`]
      case 'model.message': { const t = e.message.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join(''); return t ? [`模型: ${clip(t, 110)}`] : [] }
      case 'context.compacted': return ['（上下文被压缩）']
      case 'turn.ended': return [`结束: ${e.reason}${e.error ? ` ${e.error.code}: ${clip(e.error.message, 80)}` : ''}`]
      default: return []
    }
  })
  return lines.slice(-n)
}

export function summarize(results: TrialResult[], o: { failures?: number } = {}): Report {
  const ids = [...new Set(results.map(r => r.taskId))]
  const byTask = ids.map((id): TaskRow => {
    const rs = results.filter(r => r.taskId === id)
    return { id, tags: rs[0]!.tags, trials: rs.length, passes: rs.filter(r => r.status === 'pass').length,
      steps: median(rs.map(r => r.metrics.steps)), tokens: median(rs.map(r => r.metrics.inputTokens + r.metrics.outputTokens)), durationMs: median(rs.map(r => r.metrics.durationMs)) }
  })
  const tags = [...new Set(results.flatMap(r => r.tags))].sort()
  const byLayer: Record<string, number> = {}
  for (const r of results) if (r.layer) byLayer[r.layer] = (byLayer[r.layer] ?? 0) + 1
  const sum = (f: (m: Metrics) => number) => results.reduce((n, r) => n + f(r.metrics), 0)

  // 失败案例：先每个任务各挑一个，不够再补同一任务的其他次，免得三个案例全是同一道题。
  const bad = results.filter(r => r.status !== 'pass')
  const firsts = ids.flatMap(id => bad.filter(r => r.taskId === id).slice(0, 1))
  const picked = [...firsts, ...bad.filter(r => !firsts.includes(r))].slice(0, o.failures ?? 3)
  return {
    trials: results.length, passes: results.filter(r => r.status === 'pass').length, errors: results.filter(r => r.status === 'error').length,
    inputTokens: sum(m => m.inputTokens), outputTokens: sum(m => m.outputTokens), cacheReadTokens: sum(m => m.cacheReadTokens), durationMs: sum(m => m.durationMs),
    byTask, byLayer,
    byTag: tags.map(tag => { const rs = results.filter(r => r.tags.includes(tag)); return { tag, trials: rs.length, passes: rs.filter(r => r.status === 'pass').length } }),
    failures: picked.map(r => ({ taskId: r.taskId, trial: r.trial, status: r.status, ...(r.layer && { layer: r.layer }), ...(r.detail && { detail: clip(r.detail, 400) }), sessionId: r.sessionId, ...(r.dir && { dir: r.dir }), tail: tail(r.events) })),
    runs: results.map(r => ({ taskId: r.taskId, trial: r.trial, status: r.status, ...(r.layer && { layer: r.layer }), metrics: r.metrics })),
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-')
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const num = (n: number) => Math.round(n).toLocaleString('en-US')

export function formatReport(r: Report, meta: { title?: string; model?: string } = {}): string {
  const out = [`# ${meta.title ?? 'Hue eval'}`, '']
  out.push(`${meta.model ? `模型 ${meta.model} · ` : ''}${r.trials} 次试跑 · **成功 ${r.passes}/${r.trials}（${pct(r.passes, r.trials)}）** · token 输入 ${num(r.inputTokens)}（缓存读 ${num(r.cacheReadTokens)}）输出 ${num(r.outputTokens)} · agent 总耗时 ${sec(r.durationMs)}`, '')
  if (r.errors) out.push(`> ⚠ ${r.errors} 次试跑是评测自己出了问题（不是 agent 做错了），成功率偏低，先修环境再重跑。`, '')
  out.push('## 按任务', '', '| 任务 | 成功 | 步数（中位） | token（中位） | 耗时（中位） |', '|---|---|---|---|---|')
  for (const t of r.byTask) out.push(`| ${t.id} | ${t.passes}/${t.trials} | ${t.steps} | ${num(t.tokens)} | ${sec(t.durationMs)} |`)
  if (r.byTag.length) {
    out.push('', '## 按标签', '', '| 标签 | 成功 |', '|---|---|')
    for (const t of r.byTag) out.push(`| ${t.tag} | ${t.passes}/${t.trials}（${pct(t.passes, t.trials)}） |`)
  }
  const layers = Object.entries(r.byLayer)
  if (layers.length) out.push('', '## 没通过的试跑，失败大概在哪一层（粗略判断，不是诊断）', '', layers.map(([l, n]) => `${l} ${n}`).join(' · '))
  if (r.failures.length) {
    out.push('', '## 失败案例')
    r.failures.forEach((f, i) => {
      out.push('', `### ${i + 1}. ${f.taskId} #${f.trial} — ${f.status}${f.layer ? ` / ${f.layer}` : ''}`, '')
      if (f.detail) out.push(`检查结果：${f.detail}`, '')
      out.push(`会话 \`${f.sessionId}\`${f.dir ? `，现场 \`${f.dir}\`` : ''}。最后几步：`, '', '```', ...f.tail, '```')
    })
  }
  return `${out.join('\n')}\n`
}
