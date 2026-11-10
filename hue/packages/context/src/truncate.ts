import { userText } from '@hue/core'
import type { ContextStrategy } from '@hue/core'
import { pickCut } from './cut.js'
import { strategy, type BudgetOptions } from './engine.js'
import { textTokens } from './estimate.js'

export const TRUNCATED_NOTE = '[Earlier messages were removed to fit the context window. You no longer remember them: re-read files or re-run commands if you need that information.]'

export interface TruncateOptions extends BudgetOptions {
  /** 至少保留最近几轮，默认 1（当前这一轮）。 */
  keepTurns?: number
}

/**
 * 最便宜的一种：直接丢掉最早的若干轮，换成一句说明。不调模型、没有延迟、结果可预测；
 * 代价是丢掉的信息完全没了。留一句说明是为了让模型知道"我忘了东西"，而不是对着缺了开头的对话瞎猜。
 */
export function truncate(o: TruncateOptions = {}): ContextStrategy {
  return strategy('truncate', o, async ({ view, room }) => {
    const cut = pickCut(view, room - textTokens(TRUNCATED_NOTE), o.keepTurns)
    return cut === undefined ? undefined : { cut, replacement: [userText(TRUNCATED_NOTE)] }
  })
}
