// 第 2 课的类型。和第 1 课相同的直接转出，不同的在这里重新定义：
//   - assistant 的 content 多了 reasoning（推理块，带 provider 签名）
//   - 模型接口从 complete()（一次拿全部）变成 stream()（吐一串 Chunk）
import type { Json, TextPart, ToolCallPart, ToolMessage, ToolSpec, UserMessage } from '../01-minimal-loop/loop.js'

export type { Json, TextPart, ToolCallPart, ToolResultPart, ToolMessage, ToolSpec, UserMessage, Tool } from '../01-minimal-loop/loop.js'

/** 各家 provider 自己的附加数据，key 是 provider 名。例如 { anthropic: { signature: '...' } } */
export type ProviderMetadata = Record<string, Json>

/**
 * 推理块。必须原样放进历史、原样发回给同一个 provider：
 * Anthropic 的 thinking 带加密签名，工具循环里丢了或改了，下一次请求会被拒绝。
 * text 可以是空的（display: "omitted" 时只有签名），但 providerMetadata 不能丢。
 */
export interface ReasoningPart { type: 'reasoning'; text: string; providerMetadata?: ProviderMetadata }

export type AssistantMessage = { role: 'assistant'; content: Array<TextPart | ReasoningPart | ToolCallPart> }
export type Message = UserMessage | AssistantMessage | ToolMessage

export interface ModelRequest { system: string; messages: Message[]; tools: ToolSpec[] }

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'other'

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** prompt cache 命中 / 写入。用来衡量压缩历史对缓存的代价（第 N 课）。 */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * 适配器吐给 loop 的"已整理好的"流。provider 的碎片事件在适配器里被拼好，loop 不需要懂它们。
 * 三条约定（loop 依赖它们）：
 *   1. tool-call 只在参数完整后发一次；JSON 解析失败时 input = { __raw: 原文 }。
 *   2. finish 至多一次，而且一旦出现就是最后一块。
 *   3. 流异常结束时，以 error 块收尾（或抛异常），没有 finish。
 * tool-input-delta 和 *-delta 只给 UI 看，loop 不靠它们组装 tool-call。
 */
export type Chunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'reasoning-end'; providerMetadata?: ProviderMetadata }
  | { type: 'tool-input-delta'; callId: string; name: string; delta: string }
  | { type: 'tool-call'; callId: string; name: string; input: Json }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage }
  // code / retryable 是第 3 课加的可选字段：loop 目前只用 message，但适配器要把"为什么失败"说清楚
  // （core 里超窗靠 context_overflow 触发压缩重试）。
  | { type: 'error'; message: string; code?: 'context_overflow' | 'model_error'; retryable?: boolean }

export interface StreamingModel {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<Chunk>
}
