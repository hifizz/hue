import type { Message, UserMessage } from '@hue/core'
import { messageTokens } from './estimate.js'

/** 默认至少保留最近几步（一步 = 一条 assistant 消息和它的工具结果）。 */
export const KEEP_STEPS = 6

// 压缩留下的说明 / 摘要的开头。第二次压缩时要认出它们，不把旧的说明当成"用户的任务"抄进新的替换里。
const MARKERS = ['[Earlier messages were removed', '[Summary of the earlier conversation']
const isMarker = (p: UserMessage['content'][number]) => p.type === 'text' && MARKERS.some(m => p.text.trimStart().startsWith(m))

/**
 * 可以切的位置 j（保留 view[j..]）：
 * - 某条 user 消息之前；
 * - 紧跟在 tool 消息之后的 assistant 消息之前——长任务里整个过程只有一条用户消息，只有这种位置才能切进去。
 * 这两种位置都不会拆开 tool-call 和它的 tool-result（保留下来的 assistant 的结果就跟在它后面，被丢掉的最后一条是完整的 tool 消息），
 * 保留下来的第一条要么是 user，要么是 assistant（前面接着替换进去的 user 消息），provider 对开头的要求都满足。
 */
export const cutPoints = (view: readonly Message[]): number[] =>
  view.flatMap((m, i) => (i > 0 && (m.role === 'user' || (m.role === 'assistant' && view[i - 1]!.role === 'tool')) ? [i] : []))

const turnStarts = (view: readonly Message[]): number[] => view.flatMap((m, i) => (i > 0 && m.role === 'user' ? [i] : []))

/** 切在一轮中间时，这一轮的任务（最近一条用户消息）会落在被丢掉的部分里。它得原样带过去，否则 agent 会忘了自己在做什么。 */
const taskBefore = (view: readonly Message[], cut: number): UserMessage['content'] => {
  if (view[cut]!.role !== 'assistant') return []
  for (let i = cut - 1; i >= 0; i--) { const m = view[i]!; if (m.role === 'user') return m.content.filter(p => !isMarker(p)) }
  return []
}

/** 被丢掉的部分换成什么：一条 user 消息，内容是 text；切在一轮中间时前面带上这一轮的任务原文。 */
export function replacementFor(view: readonly Message[], cut: number, text: string): Message[] {
  const task = taskBefore(view, cut)
  return [{ role: 'user', content: [...task, { type: 'text', text: task.length ? `\n\n${text}` : text }] }]
}

/**
 * 选切点：丢掉尽量少的前缀，让剩下的（加上要带过去的任务原文）放得进 room。放不进也照切到允许的最远处（尽力而为）。
 * 保护最近的部分：最近 keepTurns 轮不动，但这些轮里最早的一轮允许从中间切，只要切完还剩至少 keepSteps 步。
 * 这样一条用户消息后面跟着几十步的长任务也能压，而多轮对话里短的最近几轮仍然完整保留。没有可切的位置返回 undefined。
 */
export function pickCut(view: readonly Message[], room: number, keepTurns = 1, keepSteps = KEEP_STEPS): number | undefined {
  const protectedFrom = [0, ...turnStarts(view)].at(-Math.max(1, keepTurns)) ?? 0
  const suffix = new Array<number>(view.length + 1).fill(0), steps = new Array<number>(view.length + 1).fill(0)
  for (let i = view.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1]! + messageTokens(view[i]!)
    steps[i] = steps[i + 1]! + (view[i]!.role === 'assistant' ? 1 : 0)
  }
  const allowed = cutPoints(view).filter(j => j <= protectedFrom || steps[j]! >= keepSteps)
  for (const j of allowed) {
    const task = taskBefore(view, j)
    if (suffix[j]! + (task.length ? messageTokens({ role: 'user', content: task }) : 0) <= room) return j
  }
  return allowed.at(-1)
}
