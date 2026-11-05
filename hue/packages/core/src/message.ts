import type { Json, ProviderMetadata } from './json.js'

/**
 * Hue 自己的消息格式（provider 中立、可序列化）。
 * 不直接用 AI SDK 的 ModelMessage：core 不能依赖它，而且事件日志需要一个我们能保证长期稳定的格式。
 * 适配在 @hue/ai 里做。
 *
 * system 不是一种消息：instructions 每步单独传给模型（见 ModelRequest），
 * 这样压缩 / 回放永远不会碰到 system prompt。
 */

export interface TextPart { type: 'text'; text: string }

/** 二进制内容不进日志正文，只放引用（data: URL 仅限小图）。TODO(deep): 大附件的存储归谁（store 的 blob 接口？） */
export interface FilePart { type: 'file'; mediaType: string; url: string; name?: string }

/** 推理内容。text 可能为空（加密推理），但 providerMetadata 必须保留，否则下一轮会被 provider 拒绝。 */
export interface ReasoningPart { type: 'reasoning'; text: string; providerMetadata?: ProviderMetadata }

export interface ToolCallPart {
  type: 'tool-call'
  callId: string
  name: string
  /** 模型给的原始参数（已 JSON.parse）。解析失败时保留原文 { __raw: string }，交给 loop 报错给模型。 */
  input: Json
  providerMetadata?: ProviderMetadata
}

export interface ToolResultPart {
  type: 'tool-result'
  callId: string
  name: string
  content: ToolContent[]
  isError: boolean
}

/** 工具结果给模型看的内容。json 由 @hue/ai 决定怎么转成 provider 格式。 */
export type ToolContent = TextPart | FilePart | { type: 'json'; value: Json }

export interface UserMessage { role: 'user'; content: Array<TextPart | FilePart> }
export interface AssistantMessage {
  role: 'assistant'
  content: Array<TextPart | ReasoningPart | ToolCallPart>
  providerMetadata?: ProviderMetadata
}
/** 一个 tool 消息装同一步里所有工具结果，顺序 = 对应 tool-call 在 assistant 消息里的顺序。 */
export interface ToolMessage { role: 'tool'; content: ToolResultPart[] }

export type Message = UserMessage | AssistantMessage | ToolMessage

export const userText = (text: string): UserMessage => ({ role: 'user', content: [{ type: 'text', text }] })

export const toolCallsOf = (m: AssistantMessage): ToolCallPart[] =>
  m.content.filter((p): p is ToolCallPart => p.type === 'tool-call')
