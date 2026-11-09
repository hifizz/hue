/**
 * 回放查看器：把 sqlite 事件日志里的一个会话打印成时间线。
 *
 *   cd hue && npx tsx examples/replay.ts [db路径] [会话id]     不给会话 id 就列出所有会话
 *
 * 只读事件，不依赖别的包的内部：日志本身就是观测数据源（每步耗时、token、缓存、工具耗时、审批等待都在里面）。
 */
import { pathToFileURL } from 'node:url'
import type { HueEvent, ToolContent, Usage } from '@hue/core'
import { listSessions, sqliteStore } from '@hue/store'

const text = (c: ToolContent[]) => c.map(p => (p.type === 'text' ? p.text : p.type === 'json' ? JSON.stringify(p.value) : `[${p.type}]`)).join('')
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const tok = (u: Usage) => `in ${u.inputTokens} out ${u.outputTokens}${u.cacheReadTokens ? ` cacheRead ${u.cacheReadTokens}` : ''}${u.cacheWriteTokens ? ` cacheWrite ${u.cacheWriteTokens}` : ''}`

/** 纯函数：事件 → 文本。单独导出是为了能不碰数据库就测试。 */
export function formatTimeline(events: HueEvent[]): string {
  if (events.length === 0) return '(空会话)'
  const t0 = events[0]!.at
  const out: string[] = []
  const line = (e: HueEvent, s: string) => out.push(`${`+${sec(e.at - t0)}`.padStart(9)}  ${s}`)

  const requested = new Map<string, number>() // requestId → 发起时间
  const decisions = new Map<string, string>() // callId → 决策
  let approvalWait = 0, modelMs = 0, toolMs = 0, calls = 0, errors = 0, denied = 0

  for (const e of events) {
    switch (e.type) {
      case 'session.created': line(e, `会话创建${e.parent ? `（子会话，父 ${e.parent.sessionId} 的调用 ${e.parent.callId}）` : ''}`); break
      case 'turn.started': line(e, `── turn ${e.turnId.slice(0, 8)} 开始`); break
      case 'user.message': line(e, `${e.steer ? '插话' : '用户'}: ${clip(text(e.message.content.map(p => (p.type === 'text' ? p : { type: 'text' as const, text: `[${p.type}]` }))), 120)}`); break
      case 'step.started': line(e, `step ${e.step}${e.estimatedTokens ? `（估算输入 ${e.estimatedTokens} token）` : ''}`); break
      case 'model.message': {
        modelMs += e.durationMs
        const parts = e.message.content.map(p => p.type === 'text' ? `文本「${clip(p.text, 60)}」` : p.type === 'tool-call' ? `调用 ${p.name}` : '推理').join('，')
        line(e, `  模型 ${sec(e.durationMs)}  ${tok(e.usage)}  ${e.finishReason}${parts ? `  → ${parts}` : ''}`); break
      }
      case 'context.compacted': line(e, '  上下文被压缩'); break
      case 'tool.call': calls++; line(e, `  ▶ ${e.name} [${e.effects}] ${clip(JSON.stringify(e.input), 100)}`); break
      case 'policy.decided': {
        decisions.set(e.callId, e.decision.action)
        if (e.decision.action !== 'allow') line(e, `    policy: ${e.decision.action}${'reason' in e.decision ? ` — ${e.decision.reason}` : ''}`)
        break
      }
      case 'input.requested': requested.set(e.requestId, e.at); break
      case 'input.resolved': {
        const wait = e.at - (requested.get(e.requestId) ?? e.at); approvalWait += wait
        if (e.response.action !== 'accept') denied++
        line(e, `    询问 → ${e.response.action}（等了 ${sec(wait)}）`); break
      }
      case 'tool.result': {
        toolMs += e.durationMs; if (e.isError) errors++
        const tag = e.synthetic ? ` (${e.synthetic})` : ''
        line(e, `  ${e.isError ? '✗' : '✓'} ${e.name} ${sec(e.durationMs)}${tag}  ${clip(text(e.content), 100)}`); break
      }
      case 'turn.ended': line(e, `── turn 结束: ${e.reason}，${e.steps} 步，${tok(e.usage)}${e.error ? `，错误 ${e.error.code}: ${e.error.message}` : ''}`); break
      case 'ext': line(e, `  ext ${e.name}`); break
      default: break // 临时事件不会进日志
    }
  }

  const total = events.at(-1)!.at - t0
  const usage = events.filter((e): e is Extract<HueEvent, { type: 'model.message' }> => e.type === 'model.message').map(e => e.usage)
  const input = usage.reduce((n, u) => n + u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), 0)
  const cached = usage.reduce((n, u) => n + (u.cacheReadTokens ?? 0), 0)
  out.push('', `合计 ${sec(total)}：模型 ${sec(modelMs)}，工具 ${sec(toolMs)}，等你批准 ${sec(approvalWait)}；`
    + `${calls} 次工具调用，${errors} 个失败，${denied} 次被拒；缓存命中 ${input ? Math.round(cached / input * 100) : 0}%`)
  return out.join('\n')
}

export async function readAll(db: string, sessionId: string): Promise<HueEvent[]> {
  const store = sqliteStore(db)
  try { const a: HueEvent[] = []; for await (const e of store.read(sessionId)) a.push(e); return a } finally { store.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [db = './hue.db', sessionId] = process.argv.slice(2)
  if (!sessionId) {
    const store = sqliteStore(db)
    const rows: Array<{ sessionId: string; lastSeq: number; updatedAt: number }> = []
    for await (const s of listSessions(store)) rows.push(s)
    store.close()
    for (const s of rows.sort((a, b) => a.updatedAt - b.updatedAt)) console.log(`${new Date(s.updatedAt).toLocaleString()}  ${s.sessionId}  ${s.lastSeq} 个事件`)
    if (rows.length === 0) console.log('(没有会话)')
  } else console.log(formatTimeline(await readAll(db, sessionId)))
}
