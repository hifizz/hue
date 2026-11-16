/**
 * 检查 HUE_TRACE 文件：真实请求体里 thinking 签名有没有原样往返，缓存断点放对没有，上下文增长曲线。
 *
 *   cd hue && npx tsx examples/check-trace.ts trace.jsonl
 *
 * 只读文件，不联网。trace 每行是 {at, sessionId, type:'request'|'response', ...}（不含 key）。
 * 对应 docs/05-next-plan.md M1：thinking 签名往返、HUE_TRACE 对中转站、context 增长。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

interface Block { type: string; signature?: string; thinking?: string; data?: string; cache_control?: unknown; id?: string; tool_use_id?: string; content?: unknown; text?: string; name?: string }
interface Msg { role: string; content: string | Block[] }
interface Req { messages: Msg[]; system?: string | Block[]; tools?: Block[]; thinking?: unknown; model?: string; max_tokens?: number }
/** body 在真实 trace 里是 JSON 字符串（2026-11-12 首次真实运行发现），构造的测试数据里可以是对象。 */
export interface TraceLine { at: number; sessionId?: string; type: string; body?: Req | string; url?: string; status?: number; headers?: Record<string, string> }

export interface TraceReport {
  requests: number
  responses: Array<{ status: number; cacheHeaders: Record<string, string> }>
  thinking: { requestsWithThinkingBlocks: number; signedBlocks: number; unsignedBlocks: number; redacted: number; changedBetweenRequests: number }
  cache: { systemBreakpoint: number; toolsBreakpoint: number; lastMessageBreakpoint: number; breakpointsMax: number; overFour: number }
  pairing: { requestsChecked: number; orphanToolUse: number; orphanToolResult: number }
  growth: Array<{ n: number; messages: number; approxChars: number }>
  model?: string
}

const blocks = (m: Msg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)
const countBp = (bs: Block[] | string | undefined) => (Array.isArray(bs) ? bs.filter(b => b.cache_control).length : 0)
const chars = (r: Req) => JSON.stringify(r).length

export function checkTrace(lines: TraceLine[]): TraceReport {
  const reqs = lines.filter(l => l.type === 'request' && l.body).map((l, i): Req => {
    if (typeof l.body !== 'string') return l.body!
    try { return JSON.parse(l.body) as Req } catch { throw new Error(`第 ${i + 1} 个请求的 body 不是合法 JSON`) }
  })
  const rep: TraceReport = {
    requests: reqs.length,
    responses: lines.filter(l => l.type === 'response').map(l => ({ status: l.status ?? 0, cacheHeaders: Object.fromEntries(Object.entries(l.headers ?? {}).filter(([k]) => /cache|request-id|ratelimit|via|server/i.test(k))) })),
    thinking: { requestsWithThinkingBlocks: 0, signedBlocks: 0, unsignedBlocks: 0, redacted: 0, changedBetweenRequests: 0 },
    cache: { systemBreakpoint: 0, toolsBreakpoint: 0, lastMessageBreakpoint: 0, breakpointsMax: 0, overFour: 0 },
    pairing: { requestsChecked: 0, orphanToolUse: 0, orphanToolResult: 0 },
    growth: [], model: reqs[0]?.model,
  }
  const seenSig = new Map<string, string>() // 签名 → 第一次见到时的 thinking 文本，用来发现"同一签名对应的文本变了"
  reqs.forEach((r, i) => {
    const sys = countBp(r.system), tools = countBp(r.tools)
    const last = r.messages.at(-1); const lastBp = last ? countBp(blocks(last)) : 0
    const all = sys + tools + r.messages.reduce((n, m) => n + countBp(blocks(m)), 0)
    rep.cache.systemBreakpoint += sys ? 1 : 0; rep.cache.toolsBreakpoint += tools ? 1 : 0; rep.cache.lastMessageBreakpoint += lastBp ? 1 : 0
    rep.cache.breakpointsMax = Math.max(rep.cache.breakpointsMax, all); if (all > 4) rep.cache.overFour++

    let hadThinking = false
    const uses = new Set<string>(), results = new Set<string>()
    for (const m of r.messages) for (const b of blocks(m)) {
      if (b.type === 'thinking') {
        hadThinking = true
        if (typeof b.signature === 'string' && b.signature) {
          rep.thinking.signedBlocks++
          const prev = seenSig.get(b.signature)
          if (prev === undefined) seenSig.set(b.signature, b.thinking ?? ''); else if (prev !== (b.thinking ?? '')) rep.thinking.changedBetweenRequests++
        } else rep.thinking.unsignedBlocks++
      } else if (b.type === 'redacted_thinking') { hadThinking = true; rep.thinking.redacted++ }
      else if (b.type === 'tool_use' && b.id) uses.add(b.id)
      else if (b.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id)
    }
    if (hadThinking) rep.thinking.requestsWithThinkingBlocks++
    rep.pairing.requestsChecked++
    // 最后一条 assistant 之后的 tool_result 才是这一步的结果；历史里每个 tool_use 都必须有 tool_result，反之亦然
    for (const id of uses) if (!results.has(id)) rep.pairing.orphanToolUse++
    for (const id of results) if (!uses.has(id)) rep.pairing.orphanToolResult++
    rep.growth.push({ n: i + 1, messages: r.messages.length, approxChars: chars(r) })
  })
  return rep
}

export function formatTraceReport(r: TraceReport): string {
  const o: string[] = [`# trace 检查：${r.requests} 个请求${r.model ? `，模型 ${r.model}` : ''}`, '']
  o.push('## 1. 响应（中转站有没有改东西）')
  const statuses = r.responses.reduce<Record<number, number>>((a, x) => ({ ...a, [x.status]: (a[x.status] ?? 0) + 1 }), {})
  o.push(`状态码：${JSON.stringify(statuses)}。${r.responses[0] ? `首个响应里与缓存 / 限流 / 转发相关的头：${JSON.stringify(r.responses[0].cacheHeaders)}` : ''}`)
  o.push('', '## 2. thinking 签名往返')
  const t = r.thinking
  if (!t.requestsWithThinkingBlocks) o.push('请求里没有出现历史 thinking 块：要么模型没产生推理，要么多轮 + 工具调用的场景没跑到。**这一项不能算通过。**')
  else {
    o.push(`${t.requestsWithThinkingBlocks} 个请求带了历史 thinking 块：带签名 ${t.signedBlocks}，redacted ${t.redacted}，**缺签名 ${t.unsignedBlocks}**，同一签名对应文本被改过 ${t.changedBetweenRequests}。`)
    o.push(t.unsignedBlocks || t.changedBetweenRequests ? '**有问题**：缺签名或文本被改，provider 会拒绝（或静默丢弃推理）。' : '签名原样往返：通过。')
  }
  o.push('', '## 3. 缓存断点', `带断点的请求数：system ${r.cache.systemBreakpoint}、tools ${r.cache.toolsBreakpoint}、最后一条消息 ${r.cache.lastMessageBreakpoint}；单个请求最多 ${r.cache.breakpointsMax} 个断点（Anthropic 上限 4，超过的请求 ${r.cache.overFour} 个）。`)
  o.push('', '## 4. tool_use / tool_result 配对', `检查了 ${r.pairing.requestsChecked} 个请求：孤立的 tool_use ${r.pairing.orphanToolUse}，孤立的 tool_result ${r.pairing.orphanToolResult}。非 0 会被 provider 拒绝。`)
  o.push('', '## 5. 请求体增长（字符数，粗略代表上下文）', ...r.growth.map(g => `- 第 ${g.n} 个：${g.messages} 条消息，${g.approxChars} 字符`))
  return o.join('\n')
}

export function parseTrace(text: string): TraceLine[] {
  return text.split('\n').filter(Boolean).flatMap((l, i) => { try { return [JSON.parse(l) as TraceLine] } catch { throw new Error(`trace 第 ${i + 1} 行不是合法 JSON`) } })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  if (!file) { console.error('用法: npx tsx examples/check-trace.ts <trace.jsonl>'); process.exit(2) }
  console.log(formatTraceReport(checkTrace(parseTrace(readFileSync(file, 'utf8')))))
}
