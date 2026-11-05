import type { HueEvent } from './event.js'
import type { Message, ToolMessage, ToolResultPart } from './message.js'
import { toolCallsOf } from './message.js'
import type { Usage } from './model.js'
import { addUsage, emptyUsage } from './model.js'

/**
 * 压缩记录。把 messages[0 .. throughIndex) 换成 summary。
 * 存在事件里，所以回放时不需要再调一次模型。
 */
export interface Compaction {
  strategy: string
  /** 被替换掉的消息区间上界（不含），指向 fold 后的完整 transcript 下标 */
  throughIndex: number
  /** 替换进来的消息（通常是一条 user 消息，内容是摘要） */
  replacement: Message[]
  tokensBefore: number
  tokensAfter: number
}

/** 事件的投影。纯函数可得，可随时从日志重建。 */
export interface ConversationState {
  sessionId: string
  /** 完整 transcript（从不删除） */
  transcript: Message[]
  /** 最近一次压缩；context 策略据此生成模型视图 */
  compaction?: Compaction
  lastSeq: number
  usage: Usage
  /** 有 call 没 result 的工具调用（崩溃 / 进行中） */
  danglingCalls: Array<{ callId: string; name: string; effects: string }>
  /** 当前是否在一个未结束的 turn 里 */
  openTurnId?: string
}

export const emptyState = (sessionId: string): ConversationState => ({
  sessionId, transcript: [], lastSeq: 0, usage: emptyUsage(), danglingCalls: [],
})

/**
 * 把一个事件折进状态。不变量：
 * - transcript 里每个 tool-call 后面紧跟的 tool 消息里都有它的 result（repair 之后）
 * - 只看 durable 事件；ephemeral 事件直接忽略
 */
export function reduce(s: ConversationState, e: HueEvent): ConversationState {
  if (e.seq > 0) s = { ...s, lastSeq: Math.max(s.lastSeq, e.seq) }
  switch (e.type) {
    case 'turn.started':
      return { ...s, openTurnId: e.turnId }
    case 'turn.ended':
      return { ...s, openTurnId: undefined, usage: addUsage(s.usage, e.usage) }
    case 'user.message':
      return { ...s, transcript: [...s.transcript, e.message] }
    case 'model.message':
      return {
        ...s,
        transcript: [...s.transcript, e.message],
        danglingCalls: toolCallsOf(e.message).map(c => ({ callId: c.callId, name: c.name, effects: 'unknown' })),
      }
    case 'tool.call':
      return { ...s, danglingCalls: s.danglingCalls.map(d => d.callId === e.callId ? { ...d, effects: e.effects } : d) }
    case 'tool.result': {
      const part: ToolResultPart = { type: 'tool-result', callId: e.callId, name: e.name, content: e.content, isError: e.isError }
      return { ...s, transcript: appendToolResult(s.transcript, part), danglingCalls: s.danglingCalls.filter(d => d.callId !== e.callId) }
    }
    case 'context.compacted':
      return { ...s, compaction: e.compaction }
    default:
      return s
  }
}

export const fold = (sessionId: string, events: Iterable<HueEvent>): ConversationState => {
  let s = emptyState(sessionId)
  for (const e of events) s = reduce(s, e)
  return s
}

/** 同一步的结果合并进同一条 tool 消息，保证 provider 要求的 call/result 成对相邻。 */
function appendToolResult(t: Message[], part: ToolResultPart): Message[] {
  const last = t[t.length - 1]
  if (last?.role === 'tool') return [...t.slice(0, -1), { role: 'tool', content: [...last.content, part] } satisfies ToolMessage]
  return [...t, { role: 'tool', content: [part] }]
}

/**
 * 模型视图的默认投影：应用 compaction，并把 tool 消息里的结果按 assistant 的 call 顺序排好。
 * ContextStrategy 可以在此基础上再加工。
 */
export function modelView(s: ConversationState): Message[] {
  const base = s.compaction ? [...s.compaction.replacement, ...s.transcript.slice(s.compaction.throughIndex)] : s.transcript
  return base.map((m, i) => {
    if (m.role !== 'tool') return m
    const prev = base[i - 1]
    if (prev?.role !== 'assistant') return m
    const order = new Map(toolCallsOf(prev).map((c, k) => [c.callId, k]))
    return { role: 'tool', content: [...m.content].sort((a, b) => (order.get(a.callId) ?? 0) - (order.get(b.callId) ?? 0)) }
  })
}
