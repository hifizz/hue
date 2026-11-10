import type { ContextStrategy, Message, ToolResultPart } from '@hue/core'
import { strategy, type BudgetOptions } from './engine.js'
import { messageTokens, messagesTokens } from './estimate.js'

export interface FoldOptions extends BudgetOptions {
  /** 最近这么多条消息原样保留，默认 8。模型马上要用到的往往就是刚拿到的结果。 */
  keepRecent?: number
  /** 短于这个字符数的结果不折叠，默认 500。折叠后的占位符本身也比它短，所以不会被反复折叠。 */
  minChars?: number
}

const size = (r: ToolResultPart): number =>
  r.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : c.type === 'json' ? JSON.stringify(c.value).length : 2000), 0)

function fold(m: Message, minChars: number): Message {
  if (m.role !== 'tool') return m
  return {
    role: 'tool',
    content: m.content.map(r => {
      const n = size(r)
      if (n < minChars) return r
      // 保留调用、保留 isError、保留工具名：对话的骨架（做过什么）还在，丢的只是很占地方的输出本身。
      return { ...r, content: [{ type: 'text', text: `[Output of ${r.name} omitted to save context (${n} chars). Run the tool again if you need it.]` }] }
    }),
  }
}

/**
 * 只折叠旧的工具结果，不动对话本身：从最早的开始，折到放得下为止。
 * 编码 agent 里体积的大头几乎都是工具结果（读过的文件、测试输出），而它们过期得最快，所以这是性价比最高的一步。
 * 不调模型；信息丢失可恢复（重新跑一次工具）。局限：不折叠 assistant 自己写的长参数（比如 write 的整个文件内容）。
 */
export function foldToolResults(o: FoldOptions = {}): ContextStrategy {
  const keep = o.keepRecent ?? 8, minChars = o.minChars ?? 500
  return strategy('fold-tool-results', o, async ({ view, room }) => {
    const limit = view.length - keep
    if (limit <= 0) return undefined
    const out: Message[] = []
    let total = messagesTokens(view)
    for (let i = 0; i < limit && total > room; i++) {
      const folded = fold(view[i]!, minChars)
      total += messageTokens(folded) - messageTokens(view[i]!)
      out.push(folded)
    }
    return out.length ? { cut: out.length, replacement: out } : undefined
  })
}
