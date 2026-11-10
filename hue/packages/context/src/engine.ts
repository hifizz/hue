import { modelView } from '@hue/core'
import type { Compaction, ContextStrategy, ConversationState, Message } from '@hue/core'
import { fixedTokens, messagesTokens } from './estimate.js'

export interface BudgetOptions {
  /** 估算超过这个 token 数就压缩。默认模型上下文窗口的 80%（留余量给输出和估算误差）。 */
  budget?: number
  /**
   * 压到多少为止。默认 budget 的一半。
   * 压到远低于触发线，是为了不要每一步都压：每次压缩都会改写前缀、让 prompt cache 失效，
   * 压到刚好卡线下的话，下一步又超，等于每步都付一次缓存的代价。
   */
  target?: number
}

/** 新的模型视图 = replacement ++ view.slice(cut)。 */
export interface Edit {
  cut: number
  replacement: Message[]
  /** 默认是策略名；回退到别的做法时写明，日志里能看出来。 */
  strategy?: string
}

export interface Plan {
  /** 当前模型视图（已应用之前的压缩）。 */
  view: Message[]
  /** 视图部分最多还能占多少 token（目标减去系统提示和工具的固定开销）。 */
  room: number
  signal: AbortSignal
}

/**
 * 所有策略的公共外壳：决定要不要压、压到哪、把 Edit 换算成 core 要的 Compaction。
 * 具体策略只回答一个问题：给定视图和空间，怎么改。
 */
export function strategy(name: string, o: BudgetOptions, propose: (p: Plan) => Promise<Edit | undefined>): ContextStrategy {
  return {
    specVersion: 'hue.context.v1',
    name,
    async prepare(input) {
      const view = modelView(input.state)
      const fixed = fixedTokens(input.instructions, input.tools)
      const before = fixed + messagesTokens(view)
      const budget = o.budget ?? Math.floor(input.model.info.contextWindow * 0.8)
      if (!input.overflowed && before <= budget) return { messages: view, estimatedTokens: before }

      // 超窗重试时我们的估算是错的（低估了），所以不信它：至少压掉 40%。
      const target = input.overflowed ? Math.min(o.target ?? Math.floor(budget * 0.5), Math.floor(before * 0.6)) : o.target ?? Math.floor(budget * 0.5)
      const edit = await propose({ view, room: Math.max(0, target - fixed), signal: input.signal })
      if (!edit || isNoop(view, edit)) return { messages: view, estimatedTokens: before }

      const compaction = toCompaction(edit.strategy ?? name, input.state, view, edit)
      const messages = modelView({ ...input.state, compaction })
      const after = fixed + messagesTokens(messages)
      return { messages, compaction: { ...compaction, tokensBefore: before, tokensAfter: after }, estimatedTokens: after }
    },
  }
}

const isNoop = (view: Message[], e: Edit) => JSON.stringify(e.replacement) === JSON.stringify(view.slice(0, e.cut))

/**
 * core 的 Compaction 是"把完整 transcript 的前 throughIndex 条换成 replacement"，
 * 而策略是在已经压缩过的视图上工作的，下标要换算。
 * 视图 = 旧 replacement（r 条）++ transcript.slice(T)。
 * - 切点在旧 replacement 之后：新的 throughIndex 往后推，新 replacement 取代旧的整段。
 * - 切点落在旧 replacement 里面：throughIndex 不动，旧 replacement 没被切到的尾巴要接在新 replacement 后面。
 */
function toCompaction(name: string, state: ConversationState, view: Message[], e: Edit): Compaction {
  if (e.cut < 1 || e.cut > view.length) throw new RangeError(`cut ${e.cut} is outside the view (${view.length} messages)`)
  const r = state.compaction?.replacement.length ?? 0
  const T = state.compaction?.throughIndex ?? 0
  return e.cut >= r
    ? { strategy: name, throughIndex: T + e.cut - r, replacement: e.replacement, tokensBefore: 0, tokensAfter: 0 }
    : { strategy: name, throughIndex: T, replacement: [...e.replacement, ...view.slice(e.cut, r)], tokensBefore: 0, tokensAfter: 0 }
}
