import type { EventStore } from '@hue/core'

export interface SessionInfo {
  sessionId: string
  lastSeq: number
  /** 最后一个事件的 at。 */
  updatedAt: number
  /** 子 agent 的会话指向启动它的那次工具调用（取自第一个 session.created 事件）。 */
  parent?: { sessionId: string; turnId: string; callId: string }
}

/** 端口之外的扩展：给 runtime / CLI 列会话用。loop 不需要它，所以不放进 core 的 EventStore。 */
export interface ListableStore extends EventStore {
  sessions(): AsyncIterable<SessionInfo>
}
