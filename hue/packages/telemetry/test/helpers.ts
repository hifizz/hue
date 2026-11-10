import type { HueEvent, Usage } from '@hue/core'
import type { Span } from '../src/index.js'

let id = 0
export const usage = (i = 10, o = 5, cr = 0, cw = 0): Usage => ({ inputTokens: i, outputTokens: o, ...(cr && { cacheReadTokens: cr }), ...(cw && { cacheWriteTokens: cw }) })
type Over = { at?: number; sessionId?: string; turnId?: string; step?: number }
const env = (o: Over) => ({ v: 1 as const, id: `ev${++id}`, sessionId: o.sessionId ?? 's', seq: 0, at: o.at ?? 0, ...(o.turnId !== undefined ? { turnId: o.turnId } : { turnId: 't1' }), ...(o.step && { step: o.step }) })

/** 构造事件的小工具。at 用毫秒数,方便算时长。 */
export const ev = {
  created: (o: Over & { parent?: { sessionId: string; turnId: string; callId: string } } = {}): HueEvent => ({ ...env(o), type: 'session.created', ...(o.parent && { parent: o.parent }) }),
  turn: (o: Over = {}): HueEvent => ({ ...env(o), type: 'turn.started', turnId: o.turnId ?? 't1' }),
  step: (o: Over & { est?: number } = {}): HueEvent => ({ ...env(o), type: 'step.started', step: o.step ?? 1, ...(o.est && { estimatedTokens: o.est }) }),
  model: (o: Over & { modelId?: string; u?: Usage; finish?: 'stop' | 'tool-calls' | 'aborted'; ms?: number } = {}): HueEvent =>
    ({ ...env(o), type: 'model.message', message: { role: 'assistant', content: [] }, modelId: o.modelId ?? 'anthropic:claude-x', finishReason: o.finish ?? 'stop', usage: o.u ?? usage(), durationMs: o.ms ?? 100 }),
  call: (callId: string, o: Over & { name?: string; input?: object } = {}): HueEvent => ({ ...env(o), type: 'tool.call', callId, name: o.name ?? 'bash', input: (o.input ?? { command: 'ls' }) as never, effects: 'unsafe' }),
  policy: (callId: string, action: 'allow' | 'ask' | 'deny', o: Over = {}): HueEvent => ({ ...env(o), type: 'policy.decided', callId, decision: action === 'ask' ? { action, prompt: 'ok?' } : action === 'deny' ? { action, reason: 'no' } : { action } }),
  ask: (requestId: string, callId: string, o: Over = {}): HueEvent => ({ ...env(o), type: 'input.requested', requestId, callId, request: { kind: 'approval', prompt: 'ok?' } }),
  answer: (requestId: string, o: Over = {}): HueEvent => ({ ...env(o), type: 'input.resolved', requestId, response: { action: 'accept' } }),
  result: (callId: string, o: Over & { name?: string; text?: string; error?: { code: 'tool_error' | 'crashed' | 'policy_denied'; message: string }; synthetic?: 'denied' | 'crashed'; ms?: number } = {}): HueEvent =>
    ({ ...env(o), type: 'tool.result', callId, name: o.name ?? 'bash', content: [{ type: 'text', text: o.text ?? 'ok' }], isError: !!o.error, durationMs: o.ms ?? 1, ...(o.error && { error: o.error }), ...(o.synthetic && { synthetic: o.synthetic }) }),
  compacted: (o: Over = {}): HueEvent => ({ ...env(o), type: 'context.compacted', compaction: { strategy: 'fold-tool-results', throughIndex: 3, replacement: [], tokensBefore: 900, tokensAfter: 300 } }),
  end: (reason: 'stop' | 'error' | 'interrupted' | 'stop_condition', o: Over & { u?: Usage; steps?: number; error?: { code: 'model_error' | 'context_overflow'; message: string } } = {}): HueEvent =>
    ({ ...env(o), type: 'turn.ended', turnId: o.turnId ?? 't1', reason, usage: o.u ?? usage(), steps: o.steps ?? 1, ...(o.error && { error: o.error }) }),
}

export const byName = (spans: Span[], prefix: string) => spans.filter(s => s.name.startsWith(prefix))
