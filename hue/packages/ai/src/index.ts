import type { ModelPort } from '@hue/core'
import { anthropicModel, type AnthropicOptions } from './anthropic.js'

export type { AnthropicOptions } from './anthropic.js'
export { anthropicModel } from './anthropic.js'

export type ModelOptions = AnthropicOptions

/** 'anthropic:claude-sonnet-5-5' → ModelPort。按第一个冒号前的前缀分发，未知前缀直接抛错。 */
export function model(id: string, opts: ModelOptions = {}): ModelPort {
  const i = id.indexOf(':')
  const provider = id.slice(0, i), name = id.slice(i + 1)
  if (i <= 0 || !name) throw new Error(`model id must look like "provider:model", got "${id}"`)
  switch (provider) {
    case 'anthropic': return anthropicModel(name, opts)
    case 'openai': throw new Error('provider "openai" is not implemented yet (see packages/ai/DECISIONS.md)')
    default: throw new Error(`unknown model provider "${provider}" in "${id}"`)
  }
}
