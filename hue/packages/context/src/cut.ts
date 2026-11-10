import type { Message } from '@hue/core'
import { messageTokens } from './estimate.js'

/**
 * 可以切的位置：某条 user 消息之前。
 * 只在这里切，tool-call 和它的 tool-result 就不会被拆开（一对调用结果总是在同一个 user 消息之后、下一个之前），
 * 保留下来的第一条也一定是 user，provider 对开头的要求也满足。
 */
export const turnStarts = (view: readonly Message[]): number[] => view.flatMap((m, i) => (i > 0 && m.role === 'user' ? [i] : []))

/**
 * 选切点：丢掉尽量少的前缀，让剩下的放得进 room；但最近 keepTurns 轮一定保留。
 * 放不进也照切到允许的最远处（尽力而为）。没有可切的位置（只有一轮）返回 undefined。
 */
export function pickCut(view: readonly Message[], room: number, keepTurns = 1): number | undefined {
  const starts = turnStarts(view)
  const maxCut = starts.at(-Math.max(1, keepTurns))
  if (maxCut === undefined) return undefined

  const suffix = new Array<number>(view.length + 1).fill(0)
  for (let i = view.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + messageTokens(view[i]!)
  for (const j of starts) if (j <= maxCut && suffix[j]! <= room) return j
  return maxCut
}
