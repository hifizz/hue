import { createHash } from 'node:crypto'
import type { HueEvent } from '@hue/core'

export type Attr = string | number | boolean | string[]
export interface SpanEvent { name: string; atMs: number; attributes: Record<string, Attr> }
export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'client' | 'internal'
  startMs: number
  endMs: number
  attributes: Record<string, Attr>
  events: SpanEvent[]
  error?: { type: string; message?: string }
}

export interface BuilderOptions {
  /** 把工具参数和结果写进 span(gen_ai.tool.call.arguments / result)。默认不写:里面可能有代码、路径、密钥。 */
  captureContent?: boolean
}

// ID 由事件里已有的 ID 哈希出来:同一份日志不管导出几次、在哪个进程里导出,span 都是同一个。
const hex = (n: number, ...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, n)
const traceOf = (sessionId: string, turnId = '') => hex(32, 'trace', sessionId, turnId)
const turnSpan = (sessionId: string, turnId: string) => hex(16, 'turn', sessionId, turnId)
const toolSpan = (sessionId: string, callId: string) => hex(16, 'tool', sessionId, callId)

const json = (v: unknown) => { try { return JSON.stringify(v) ?? '' } catch { return '' } }
const textOf = (c: Array<{ type: string; text?: string }>) => c.map(p => (p.type === 'text' ? p.text ?? '' : `[${p.type}]`)).join('')
const MAX_CONTENT = 4096

interface OpenTurn { span: Span; model?: string }
interface OpenTool { span: Span; waitMs: number }

/**
 * 事件 → span 的状态机。一次 turn = 一个 invoke_agent span;每次 model.message = 一个 inference span;
 * 每次 tool.call → tool.result = 一个 execute_tool span。
 * 一个用户请求(根会话的一个 turn)= 一条 trace;子 agent 的 turn 挂在父会话派它的那次 execute_tool 下面,和父同一条 trace。
 */
export function spanBuilder(o: BuilderOptions = {}) {
  const turns = new Map<string, OpenTurn>() // sessionId/turnId
  const tools = new Map<string, OpenTool>() // sessionId/callId
  const turnTrace = new Map<string, string>()
  const asks = new Map<string, { key: string; at: number }>() // requestId → 哪个调用在等
  const sessionTrace = new Map<string, { traceId: string; parent: string }>()
  const remember = <V>(m: Map<string, V>, k: string, v: V) => { m.set(k, v); if (m.size > 2000) m.delete(m.keys().next().value!) }

  function traceFor(e: HueEvent): string {
    return sessionTrace.get(e.sessionId)?.traceId ?? turnTrace.get(`${e.sessionId}/${e.turnId}`) ?? traceOf(e.sessionId, e.turnId)
  }
  function openTurn(e: HueEvent, turnId: string): OpenTurn {
    const k = `${e.sessionId}/${turnId}`
    let t = turns.get(k)
    if (!t) {
      const link = sessionTrace.get(e.sessionId)
      const traceId = link?.traceId ?? traceOf(e.sessionId, turnId)
      turnTrace.set(k, traceId)
      t = { span: { traceId, spanId: turnSpan(e.sessionId, turnId), parentSpanId: link?.parent, name: 'invoke_agent', kind: 'client', startMs: e.at, endMs: e.at, events: [],
        attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': e.sessionId } } }
      turns.set(k, t)
    }
    return t
  }
  const fail = (s: Span, type: string, message?: string) => { s.error = { type, ...(message && { message }) }; s.attributes['error.type'] = type }

  function push(e: HueEvent): Span[] {
    const out: Span[] = []
    switch (e.type) {
      case 'session.created':
        if (e.parent) {
          const pk = `${e.parent.sessionId}/${e.parent.turnId}`
          remember(sessionTrace, e.sessionId, { traceId: turnTrace.get(pk) ?? sessionTrace.get(e.parent.sessionId)?.traceId ?? traceOf(e.parent.sessionId, e.parent.turnId), parent: toolSpan(e.parent.sessionId, e.parent.callId) })
        }
        break
      case 'turn.started': openTurn(e, e.turnId).span.startMs = e.at; break
      case 'step.started': if (e.turnId) { const t = openTurn(e, e.turnId); if (e.estimatedTokens) t.span.attributes['hue.estimated_input_tokens'] = e.estimatedTokens } break
      case 'context.compacted': {
        const t = e.turnId && turns.get(`${e.sessionId}/${e.turnId}`)
        if (t) t.span.events.push({ name: 'hue.context.compacted', atMs: e.at, attributes: { 'hue.compaction.strategy': e.compaction.strategy, 'hue.compaction.tokens_before': e.compaction.tokensBefore, 'hue.compaction.tokens_after': e.compaction.tokensAfter } })
        break
      }
      case 'model.message': {
        if (!e.turnId) break
        const provider = e.modelId.includes(':') ? e.modelId.slice(0, e.modelId.indexOf(':')) : 'unknown'
        const model = e.modelId.includes(':') ? e.modelId.slice(e.modelId.indexOf(':') + 1) : e.modelId
        const u = e.usage, cacheRead = u.cacheReadTokens ?? 0, cacheWrite = u.cacheWriteTokens ?? 0
        const s: Span = { traceId: traceFor(e), spanId: hex(16, 'chat', e.id), parentSpanId: turnSpan(e.sessionId, e.turnId), name: `chat ${model}`, kind: 'client', startMs: e.at - e.durationMs, endMs: e.at, events: [],
          attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider, 'gen_ai.request.model': model, 'gen_ai.response.model': model, 'gen_ai.response.finish_reasons': [e.finishReason === 'aborted' ? 'interrupted' : e.finishReason], // 约定偏向 provider 原始值;日志里只有 Hue 归一化后的(tool-calls 而不是 tool_use),被打断记 interrupted
            // Hue 的 inputTokens 不含缓存(Anthropic 的算法);OTel 约定要求含缓存,所以这里加回去。
            'gen_ai.usage.input_tokens': u.inputTokens + cacheRead + cacheWrite, 'gen_ai.usage.output_tokens': u.outputTokens,
            ...(cacheRead && { 'gen_ai.usage.cache_read.input_tokens': cacheRead }), ...(cacheWrite && { 'gen_ai.usage.cache_write.input_tokens': cacheWrite }), ...(e.step && { 'hue.step': e.step }) } }
        if (e.finishReason === 'aborted') fail(s, 'aborted')
        const t = openTurn(e, e.turnId); t.model ??= model
        out.push(s)
        break
      }
      case 'tool.call': {
        const sp: Span = { traceId: traceFor(e), spanId: toolSpan(e.sessionId, e.callId), parentSpanId: e.turnId ? turnSpan(e.sessionId, e.turnId) : undefined, name: `execute_tool ${e.name}`, kind: 'internal', startMs: e.at, endMs: e.at, events: [],
          attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': e.name, 'gen_ai.tool.call.id': e.callId, 'gen_ai.tool.type': 'function', 'hue.tool.effects': e.effects, ...(e.step && { 'hue.step': e.step }),
            ...(o.captureContent && { 'gen_ai.tool.call.arguments': json(e.input).slice(0, MAX_CONTENT) }) } }
        remember(tools, `${e.sessionId}/${e.callId}`, { span: sp, waitMs: 0 })
        break
      }
      case 'policy.decided': { const t = tools.get(`${e.sessionId}/${e.callId}`); if (t) t.span.attributes['hue.policy.action'] = e.decision.action; break }
      case 'input.requested': {
        const k = e.callId ? `${e.sessionId}/${e.callId}` : ''
        const t = tools.get(k)
        if (t) { asks.set(e.requestId, { key: k, at: e.at }); t.span.events.push({ name: 'hue.input.requested', atMs: e.at, attributes: { 'hue.input.kind': e.request.kind } }) }
        break
      }
      case 'input.resolved': {
        const a = asks.get(e.requestId); asks.delete(e.requestId)
        const t = a && tools.get(a.key)
        if (t && a) { t.waitMs += e.at - a.at; t.span.events.push({ name: 'hue.input.resolved', atMs: e.at, attributes: { 'hue.input.action': e.response.action } }) }
        break
      }
      case 'tool.result': {
        const k = `${e.sessionId}/${e.callId}`
        const open = tools.get(k)
        // 没见过 tool.call:崩溃恢复补出来的结果,在另一个进程里写的。给一个零长度的 span,让它在 trace 里可见。
        const t = open ?? { span: { traceId: traceFor(e), spanId: toolSpan(e.sessionId, e.callId), parentSpanId: e.turnId ? turnSpan(e.sessionId, e.turnId) : undefined, name: `execute_tool ${e.name}`, kind: 'internal' as const, startMs: e.at - e.durationMs, endMs: e.at, events: [],
          attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': e.name, 'gen_ai.tool.call.id': e.callId, 'gen_ai.tool.type': 'function' } }, waitMs: 0 }
        t.span.endMs = e.at
        if (t.waitMs) t.span.attributes['hue.input.wait_ms'] = t.waitMs
        if (e.synthetic) t.span.attributes['hue.tool.synthetic'] = e.synthetic
        if (e.isError) fail(t.span, e.error?.code ?? 'tool_error', e.error?.message)
        else if (o.captureContent) t.span.attributes['gen_ai.tool.call.result'] = textOf(e.content).slice(0, MAX_CONTENT)
        tools.delete(k); out.push(t.span)
        break
      }
      case 'turn.ended': {
        const k = `${e.sessionId}/${e.turnId}`
        const t = openTurn(e, e.turnId)
        const u = e.usage, cr = u.cacheReadTokens ?? 0, cw = u.cacheWriteTokens ?? 0
        t.span.endMs = e.at
        Object.assign(t.span.attributes, { 'gen_ai.usage.input_tokens': u.inputTokens + cr + cw, 'gen_ai.usage.output_tokens': u.outputTokens, 'hue.turn.end_reason': e.reason, 'hue.turn.steps': e.steps },
          cr && { 'gen_ai.usage.cache_read.input_tokens': cr }, cw && { 'gen_ai.usage.cache_write.input_tokens': cw })
        if (t.model) Object.assign(t.span.attributes, { 'gen_ai.request.model': t.model })
        if (e.reason === 'error') fail(t.span, e.error?.code ?? 'error', e.error?.message)
        // 被打断不算错误(是用户要的),只记在 end_reason 里。
        for (const [tk, tool] of tools) if (tk.startsWith(`${e.sessionId}/`) && tool.span.parentSpanId === t.span.spanId) { tool.span.endMs = e.at; fail(tool.span, 'unfinished'); out.push(tool.span); tools.delete(tk) }
        out.push(t.span); turns.delete(k); turnTrace.delete(k)
        break
      }
      default: break
    }
    return out
  }

  /** 还没结束的 span(日志在中途断了):以 at 为结束时间,标 unfinished。 */
  function close(at: number): Span[] {
    const out: Span[] = []
    for (const t of tools.values()) { t.span.endMs = Math.max(at, t.span.startMs); fail(t.span, 'unfinished'); out.push(t.span) }
    for (const t of turns.values()) { t.span.endMs = Math.max(at, t.span.startMs); fail(t.span, 'unfinished'); out.push(t.span) }
    tools.clear(); turns.clear()
    return out
  }
  return { push, close }
}
