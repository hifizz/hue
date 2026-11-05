import type { Json } from './json.js'
import type { HueError } from './errors.js'
import type { AssistantMessage, ToolContent, UserMessage } from './message.js'
import type { FinishReason, Usage } from './model.js'
import type { Effects } from './tool.js'
import type { PolicyDecision, InputRequest, InputResponse } from './ports.js'
import type { Compaction } from './fold.js'

/**
 * ─────────────── 事件是 Hue 的唯一合同 ───────────────
 * 1. 事件日志是唯一事实源；消息历史只是事件的投影（fold.ts）。
 * 2. 每个事件带 v（schema 版本），升级时新旧版本可以共存于同一日志，fold 负责兼容。
 * 3. durable 事件进日志、可回放；ephemeral 事件只给 UI / telemetry（delta、progress）。
 * 4. 包要加自己的事件，用 type: 'ext'，不改核心联合类型。
 */

export const HUE_EVENT_VERSION = 1 as const

export interface EventEnvelope {
  v: typeof HUE_EVENT_VERSION
  /** 全局唯一 */
  id: string
  sessionId: string
  /** 会话内单调递增，从 1 开始。只给 durable 事件分配；ephemeral 事件为 0。 */
  seq: number
  /** ms since epoch */
  at: number
  turnId?: string
  step?: number
}

type E<T extends string, P> = EventEnvelope & { type: T } & P

export type SessionCreated = E<'session.created', {
  /** 子 agent：指向父会话里派生它的那次工具调用，构成事件树。 */
  parent?: { sessionId: string; turnId: string; callId: string }
  meta?: Json
}>
export type TurnStarted = E<'turn.started', { turnId: string }>
/** turn 的输入，以及 turn 中途插入的用户消息（steer）。 */
export type UserMessageEvent = E<'user.message', { message: UserMessage; steer?: boolean }>
export type StepStarted = E<'step.started', { step: number; estimatedTokens?: number }>
export type ModelDelta = E<'model.delta', { kind: 'text' | 'reasoning'; delta: string }>          // ephemeral
export type ToolInputDelta = E<'tool.input.delta', { callId: string; name: string; delta: string }> // ephemeral
export type ModelMessageEvent = E<'model.message', {
  message: AssistantMessage
  modelId: string
  finishReason: FinishReason | 'aborted'
  usage: Usage
  durationMs: number
}>
export type ContextCompacted = E<'context.compacted', { compaction: Compaction }>
/** 写前日志：执行前落盘。崩溃后能看出"发起了但不知道结果"。 */
export type ToolCallEvent = E<'tool.call', { callId: string; name: string; input: Json; effects: Effects }>
export type PolicyDecided = E<'policy.decided', { callId: string; decision: PolicyDecision }>
export type ToolProgress = E<'tool.progress', { callId: string; data: Json }>                    // ephemeral
export type ToolResultEvent = E<'tool.result', {
  callId: string
  name: string
  content: ToolContent[]
  isError: boolean
  error?: HueError
  data?: Json
  durationMs: number
  /** 不是工具真的返回的，而是 loop / fold 补出来的 */
  synthetic?: 'interrupted' | 'denied' | 'crashed' | 'not_run'
}>
export type InputRequested = E<'input.requested', { requestId: string; callId?: string; request: InputRequest }>
export type InputResolved = E<'input.resolved', { requestId: string; response: InputResponse }>
export type TurnEnded = E<'turn.ended', {
  turnId: string
  reason: TurnEndReason
  usage: Usage
  steps: number
  error?: HueError
}>
export type ExtEvent = E<'ext', { name: string; durable: boolean; data: Json }>

export type TurnEndReason = 'stop' | 'stop_condition' | 'interrupted' | 'error' | 'length'

export type HueEvent =
  | SessionCreated | TurnStarted | UserMessageEvent | StepStarted
  | ModelDelta | ToolInputDelta | ModelMessageEvent | ContextCompacted
  | ToolCallEvent | PolicyDecided | ToolProgress | ToolResultEvent
  | InputRequested | InputResolved | TurnEnded | ExtEvent

export type HueEventType = HueEvent['type']

const EPHEMERAL: ReadonlySet<HueEventType> = new Set(['model.delta', 'tool.input.delta', 'tool.progress'])

export const isDurable = (e: HueEvent): boolean =>
  e.type === 'ext' ? e.durable : !EPHEMERAL.has(e.type)

/** 构造事件时的输入：信封字段由 loop 填。 */
export type EventInit<T extends HueEvent = HueEvent> =
  T extends HueEvent ? Omit<T, keyof EventEnvelope> & Partial<Pick<EventEnvelope, 'turnId' | 'step'>> : never
