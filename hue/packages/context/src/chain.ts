import { modelView } from '@hue/core'
import type { Compaction, ContextOutput, ContextStrategy } from '@hue/core'

/**
 * 依次试几个策略：前一个压完还超，后一个接着压。典型用法 chain(foldToolResults(), summarize({ model }))：
 * 先用不花钱、可恢复的折叠，不够再付摘要的代价。
 *
 * 后一个策略看到的是前一个压缩之后的状态，它算出的 Compaction 是相对完整 transcript 的，
 * 已经把前面的改动包含在 replacement 里了，所以最终只需要返回最后一个。
 */
export function chain(...list: ContextStrategy[]): ContextStrategy {
  return {
    specVersion: 'hue.context.v1',
    name: list.map(s => s.name).join('+'),
    async prepare(input) {
      let state = input.state
      let overflowed = input.overflowed
      let last: ContextOutput = { messages: modelView(state) }
      let final: Compaction | undefined
      const used: string[] = []
      let tokensBefore = 0
      for (const s of list) {
        last = await s.prepare({ ...input, state, overflowed })
        if (!last.compaction) continue
        // 已经有人压过了：后面的策略只按预算判断要不要再压，不再因为"超窗重试"而无条件压一次。
        if (!final) tokensBefore = last.compaction.tokensBefore
        final = last.compaction; used.push(last.compaction.strategy)
        state = { ...state, compaction: final }; overflowed = false
      }
      return {
        messages: last.messages,
        estimatedTokens: last.estimatedTokens,
        ...(final ? { compaction: { ...final, strategy: used.join('+'), tokensBefore } } : {}),
      }
    },
  }
}
