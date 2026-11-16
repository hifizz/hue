/**
 * M1 校准报告：从事件日志里量出几个"经验值"到底准不准。只读 sqlite，不调模型。
 *
 *   cd hue && npx tsx examples/calibrate.ts [db路径] <会话id> [会话id…]
 *   cd hue && npx tsx examples/calibrate.ts [db路径] --all
 *
 * 量什么（对应 docs/05-next-plan.md 的 M1）：
 *   1. token 估算 vs 真实 usage：context 的 estimate 故意偏高，偏多少、有没有低估（低估才危险）。
 *   2. 压缩：触发了几次、前后 token、之后一步的缓存读取（压缩会让 prompt cache 失效）。
 *   3. policy：每种工具 / 每条 bash 命令被问了几次、被拒几次（找白名单的误拦）。
 *   4. 工具：失败率、synthetic 结果、最慢的几个。
 *   5. 花费：token 合计和缓存命中（单题成本 = token × 价格，价格表在 eval 做完前由人填）。
 */
import { pathToFileURL } from 'node:url'
import type { HueEvent, Usage } from '@hue/core'
import { listSessions, sqliteStore } from '@hue/store'

export interface Calibration {
  sessions: number
  steps: number
  /** 每步：估算的输入 token（step.started）对真实输入（usage：未缓存输入 + 缓存读 + 缓存写） */
  estimate: { n: number; underEstimated: number; ratioMin: number; ratioMedian: number; ratioMax: number; worst?: { session: string; step: number; estimated: number; actual: number } }
  compactions: Array<{ session: string; strategy: string; before: number; after: number; nextStepCacheRead?: number; nextStepInput?: number }>
  policy: { allowed: number; asked: number; denied: number; byTool: Record<string, { asked: number; denied: number }>; askedCommands: string[]; deniedReasons: string[] }
  tools: { calls: number; errors: number; synthetic: Record<string, number>; slowest: Array<{ name: string; ms: number }>; errorsByTool: Record<string, number> }
  usage: Usage & { cacheHitPct: number }
  turns: Array<{ session: string; reason: string; steps: number }>
}

const fullInput = (u: Usage) => u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN }

/** 纯函数：几个会话的事件 → 校准数字。单独导出便于不碰数据库就测试。 */
export function calibrate(sessions: Array<{ id: string; events: HueEvent[] }>): Calibration {
  const ratios: number[] = []
  let worst: Calibration['estimate']['worst']; let under = 0
  const compactions: Calibration['compactions'] = []
  const policy: Calibration['policy'] = { allowed: 0, asked: 0, denied: 0, byTool: {}, askedCommands: [], deniedReasons: [] }
  const tools: Calibration['tools'] = { calls: 0, errors: 0, synthetic: {}, slowest: [], errorsByTool: {} }
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const turns: Calibration['turns'] = []
  let steps = 0

  for (const { id, events } of sessions) {
    const est = new Map<string, number>() // `${turnId}:${step}` → 估算
    const calls = new Map<string, { name: string; input: unknown }>()
    let pendingCompaction: Calibration['compactions'][number] | undefined
    for (const e of events) {
      switch (e.type) {
        case 'step.started': if (e.estimatedTokens !== undefined && e.turnId) est.set(`${e.turnId}:${e.step}`, e.estimatedTokens); break
        case 'context.compacted': {
          const c = e.compaction
          pendingCompaction = { session: id, strategy: c.strategy, before: c.tokensBefore, after: c.tokensAfter }
          compactions.push(pendingCompaction); break
        }
        case 'model.message': {
          steps++
          const actual = fullInput(e.usage)
          const estimated = e.turnId ? est.get(`${e.turnId}:${e.step}`) : undefined
          if (estimated !== undefined && actual > 0) {
            const r = estimated / actual; ratios.push(r)
            if (r < 1) under++
            if (!worst || r < worst.estimated / worst.actual) worst = { session: id, step: e.step ?? 0, estimated, actual }
          }
          if (pendingCompaction) { pendingCompaction.nextStepCacheRead = e.usage.cacheReadTokens ?? 0; pendingCompaction.nextStepInput = actual; pendingCompaction = undefined }
          total.inputTokens += e.usage.inputTokens; total.outputTokens += e.usage.outputTokens
          total.cacheReadTokens! += e.usage.cacheReadTokens ?? 0; total.cacheWriteTokens! += e.usage.cacheWriteTokens ?? 0
          break
        }
        case 'tool.call': calls.set(e.callId, { name: e.name, input: e.input }); tools.calls++; break
        case 'policy.decided': {
          const c = calls.get(e.callId); const name = c?.name ?? '?'
          const row = (policy.byTool[name] ??= { asked: 0, denied: 0 })
          if (e.decision.action === 'allow') policy.allowed++
          else if (e.decision.action === 'ask') { policy.asked++; row.asked++; if (name === 'bash') policy.askedCommands.push(String((c?.input as { command?: unknown } | undefined)?.command ?? '').slice(0, 160)) }
          else { policy.denied++; row.denied++; policy.deniedReasons.push(`${name}: ${e.decision.reason}`.slice(0, 200)) }
          break
        }
        case 'tool.result': {
          if (e.isError) { tools.errors++; tools.errorsByTool[e.name] = (tools.errorsByTool[e.name] ?? 0) + 1 }
          if (e.synthetic) tools.synthetic[e.synthetic] = (tools.synthetic[e.synthetic] ?? 0) + 1
          tools.slowest.push({ name: e.name, ms: e.durationMs }); break
        }
        case 'turn.ended': turns.push({ session: id, reason: e.reason, steps: e.steps }); break
        default: break
      }
    }
  }
  tools.slowest = tools.slowest.sort((a, b) => b.ms - a.ms).slice(0, 5)
  const input = fullInput(total)
  return {
    sessions: sessions.length, steps,
    estimate: { n: ratios.length, underEstimated: under, ratioMin: Math.min(...ratios), ratioMedian: median(ratios), ratioMax: Math.max(...ratios), worst },
    compactions, policy, tools,
    usage: { ...total, cacheHitPct: input ? Math.round(((total.cacheReadTokens ?? 0) / input) * 100) : 0 },
    turns,
  }
}

const r2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a')

export function formatCalibration(c: Calibration): string {
  const o: string[] = []
  o.push(`# 校准报告：${c.sessions} 个会话，${c.steps} 次模型调用`, '')
  o.push('## 1. token 估算 vs 真实输入')
  if (!c.estimate.n) o.push('没有可对比的步骤（step.started 没有 estimatedTokens，或 usage 缺失）。')
  else {
    o.push(`比值 = 估算 / 真实（>1 是偏高，<1 是低估）。样本 ${c.estimate.n}：最小 ${r2(c.estimate.ratioMin)}，中位 ${r2(c.estimate.ratioMedian)}，最大 ${r2(c.estimate.ratioMax)}。`)
    o.push(c.estimate.underEstimated ? `**低估了 ${c.estimate.underEstimated} 次**（压缩会来得太晚）。最差：${JSON.stringify(c.estimate.worst)}` : '没有低估：设计上"故意偏高"成立。')
    o.push('注意：真实输入包含系统提示和工具说明，估算也计入；若比值系统性远大于 1.3，说明 3.5 字符/token 偏保守。')
  }
  o.push('', '## 2. 压缩')
  if (!c.compactions.length) o.push('一次都没触发。要校准 80%/50%/6 步，需要一个够长的任务（或把窗口调小再跑）。')
  for (const k of c.compactions) o.push(`- ${k.strategy}：${k.before} → ${k.after} token；压缩后下一步缓存读取 ${k.nextStepCacheRead ?? '?'} / 输入 ${k.nextStepInput ?? '?'}`)
  o.push('', '## 3. policy（找白名单误拦）', `放行 ${c.policy.allowed}，询问 ${c.policy.asked}，拒绝 ${c.policy.denied}。`)
  for (const [t, v] of Object.entries(c.policy.byTool)) if (v.asked || v.denied) o.push(`- ${t}：问 ${v.asked}，拒 ${v.denied}`)
  if (c.policy.askedCommands.length) o.push('被问的 bash 命令（其中无害的就是该加进白名单的候选）：', ...[...new Set(c.policy.askedCommands)].map(s => `  - ${s}`))
  if (c.policy.deniedReasons.length) o.push('被拒的原因：', ...[...new Set(c.policy.deniedReasons)].map(s => `  - ${s}`))
  o.push('', '## 4. 工具', `${c.tools.calls} 次调用，${c.tools.errors} 个失败。synthetic：${JSON.stringify(c.tools.synthetic)}`)
  if (c.tools.errors) o.push(`失败分布：${JSON.stringify(c.tools.errorsByTool)}`)
  o.push(`最慢：${c.tools.slowest.map(s => `${s.name} ${(s.ms / 1000).toFixed(1)}s`).join('，')}`)
  o.push('', '## 5. 花费', `输入（未缓存）${c.usage.inputTokens}，输出 ${c.usage.outputTokens}，缓存读 ${c.usage.cacheReadTokens}，缓存写 ${c.usage.cacheWriteTokens}；缓存命中 ${c.usage.cacheHitPct}%。`,
    '美元 = 各项 token × 你的中转站价格（这里不猜价格）。')
  o.push('', '## 6. turn 结果', ...c.turns.map(t => `- ${t.session.slice(0, 8)}：${t.reason}，${t.steps} 步`))
  return o.join('\n')
}

async function load(db: string, ids: string[] | 'all'): Promise<Array<{ id: string; events: HueEvent[] }>> {
  const store = sqliteStore(db)
  try {
    let list: string[]
    if (ids === 'all') { list = []; for await (const s of listSessions(store)) list.push(s.sessionId) } else list = ids
    const out: Array<{ id: string; events: HueEvent[] }> = []
    for (const id of list) { const events: HueEvent[] = []; for await (const e of store.read(id)) events.push(e); out.push({ id, events }) }
    return out
  } finally { store.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const db = args[0] && (args[0].endsWith('.db') || args[0].includes('/')) ? args.shift()! : './hue.db'
  if (!args.length) { console.error('用法: npx tsx examples/calibrate.ts [db路径] <会话id…|--all>'); process.exit(2) }
  console.log(formatCalibration(calibrate(await load(db, args[0] === '--all' ? 'all' : args))))
}
