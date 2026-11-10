// 合同测试：真实调 Anthropic API。没有 ANTHROPIC_API_KEY 时整个文件自动 skip（CI 不需要 key）。
import { modelPortContract } from '@hue/core/contracts'
import { ai } from '../src/index.js'

modelPortContract('anthropic:claude-sonnet-4', () => {
  if (!process.env.ANTHROPIC_API_KEY) return undefined
  return ai('anthropic:claude-sonnet-4', { maxTokens: 1_024 })!
})
