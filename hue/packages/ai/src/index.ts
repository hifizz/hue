import type { ModelPort } from '@hue/core'
import { anthropicModel, type AnthropicOptions } from './anthropic.js'
import { openaiModel, type OpenAIOptions } from './openai/index.js'

export type { AnthropicOptions, TraceEvent } from './anthropic.js'
export type { OpenAIOptions } from './openai/index.js'
export { anthropicModel } from './anthropic.js'
export { openaiModel } from './openai/index.js'

/** 两家 provider 的选项并集：按 id 的前缀取各自认识的字段，多余字段忽略（调用方通常两边都透传）。 */
export type ModelOptions = AnthropicOptions & OpenAIOptions

/** 'anthropic:claude-…' 或 'openai:gpt-…' → ModelPort。按第一个冒号前的前缀分发，未知前缀直接抛错。 */
export function model(id: string, opts: ModelOptions = {}): ModelPort {
  const i = id.indexOf(':')
  const provider = id.slice(0, i), name = id.slice(i + 1)
  if (i <= 0 || !name) throw new Error(`model id must look like "provider:model", got "${id}"`)
  switch (provider) {
    case 'anthropic': return anthropicModel(name, opts)
    case 'openai': return openaiModel(name, opts)
    default: throw new Error(`unknown model provider "${provider}" in "${id}"`)
  }
}
