// 真实 API 的 ModelPort 合同：有 key 才跑，没有就 skip。
// 运行：cd hue && node --import tsx --test packages/ai/test/contract.test.ts
// OpenAI 侧用 AI_GATEWAY_API_KEY / AI_GATEWAY_BASE_URL（环境里配的是中转站），按 OpenAI 官方语义调用；
// 中转站行为不正确时在这里记录（见 DECISIONS.md），不为它做特判。
import { modelPortContract } from '@hue/core/contracts'
import { anthropicModel, openaiModel } from '../src/index.js'

const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY
modelPortContract('anthropic (live)', () => apiKey
  ? anthropicModel(process.env.HUE_LIVE_MODEL ?? 'claude-haiku-5-5', { apiKey, baseURL: process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL })
  : undefined)

// gpt-6.1-sol：实测模型（见任务）；HUE_OPENAI_LIVE_MODEL 可覆盖。
const openaiKey = process.env.OPENAI_API_KEY || process.env.AI_GATEWAY_API_KEY
modelPortContract('openai (live)', () => openaiKey
  ? openaiModel(process.env.HUE_OPENAI_LIVE_MODEL ?? 'gpt-6.1-sol', { apiKey: openaiKey, baseURL: process.env.OPENAI_BASE_URL || process.env.AI_GATEWAY_BASE_URL })
  : undefined)
