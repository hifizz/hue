import type { ConversationState } from './fold.js'
import type { AssistantMessage } from './message.js'
import type { Usage } from './model.js'

/** 每步结束后检查；返回 true 则结束 turn（reason: stop_condition）。模型没有工具调用时 turn 自然结束，不经过这里。 */
export type StopCondition = (s: { step: number; usage: Usage; last: AssistantMessage; state: ConversationState }) => boolean

export const stepCountIs = (n: number): StopCondition => ({ step }) => step >= n
export const hasToolCall = (name: string): StopCondition => ({ last }) =>
  last.content.some(p => p.type === 'tool-call' && p.name === name)
export const tokenBudget = (maxTotal: number): StopCondition => ({ usage }) =>
  usage.inputTokens + usage.outputTokens >= maxTotal
