import type { Json, JsonSchema, ProviderMetadata } from './json.js'
import type { HueError } from './errors.js'
import type { Message } from './message.js'

/**
 * 模型端口。@hue/ai 实现它；core 只认这个接口。
 * specVersion 借鉴 AI SDK 的 specificationVersion：接口改了就升版本，适配器靠它报错而不是悄悄坏掉。
 */
export interface ModelPort {
  readonly specVersion: 'hue.model.v1'
  /** 'anthropic:claude-…'，进日志用于复现和 eval 归因 */
  readonly id: string
  readonly info: ModelInfo
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>
  /** 可选的精确计数；没有时 context 用估算。 */
  countTokens?(request: Omit<ModelRequest, 'settings'>): Promise<number>
}

export interface ModelInfo {
  contextWindow: number
  maxOutputTokens?: number
  supports: { tools: boolean; parallelToolCalls: boolean; reasoning: boolean; images: boolean }
}

export interface ToolSpec { name: string; description: string; inputSchema: JsonSchema }

export interface ModelRequest {
  instructions: string
  messages: Message[]
  tools: ToolSpec[]
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  settings?: ModelSettings
}

export interface ModelSettings {
  maxOutputTokens?: number
  temperature?: number
  /** 透传给具体 provider，key 为 provider 名。 */
  providerOptions?: Record<string, Json>
}

/**
 * 流式块。适配器负责把 provider 的碎片拼好：
 * - tool-call 只在参数完整后发一次（tool-input-delta 只给 UI 用）
 * - finish 必须且只能出现一次，且是最后一块
 */
export type ModelChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'reasoning-end'; providerMetadata?: ProviderMetadata }
  | { type: 'tool-input-delta'; callId: string; name: string; delta: string }
  | { type: 'tool-call'; callId: string; name: string; input: Json; providerMetadata?: ProviderMetadata }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage; providerMetadata?: ProviderMetadata }
  | { type: 'error'; error: HueError }

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other'

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** prompt cache：读命中 / 写入。用来量化压缩对缓存的代价。 */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 })
export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
})
