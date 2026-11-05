import type { EventInit } from './event.js'
import type { ConversationState } from './fold.js'

/**
 * 崩溃恢复：进程在工具执行中途被杀，日志里留下"有 tool.call 没 tool.result"。
 * 返回需要补写的 synthetic 结果（由 runtime 落盘后再开始下一个 turn）。
 *
 * 规则：一律不自动重跑，补一条 crashed 结果交给模型判断。
 * TODO(deep): effects 为 none / idempotent 的调用是否应该自动重跑？重跑需要原始 input（在 tool.call 事件里）
 */
export function repairDangling(s: ConversationState): EventInit[] {
  const out: EventInit[] = s.danglingCalls.map(d => ({
    type: 'tool.result', callId: d.callId, name: d.name, isError: true, durationMs: 0, synthetic: 'crashed',
    error: { code: 'crashed', message: 'process crashed during tool execution' },
    content: [{ type: 'text', text: d.effects === 'none'
      ? 'The process crashed before this read-only call finished. It is safe to call it again.'
      : 'The process crashed while this call was running. Its outcome is unknown; check the current state before retrying.' }],
  }))
  if (s.openTurnId) out.push({ type: 'turn.ended', turnId: s.openTurnId, reason: 'error', usage: { inputTokens: 0, outputTokens: 0 }, steps: 0, error: { code: 'crashed', message: 'turn did not finish' } })
  return out
}
