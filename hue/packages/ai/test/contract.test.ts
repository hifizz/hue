// 真实 API 的 ModelPort 合同：有 key 才跑，没有就 skip。
// 运行：cd hue && node --env-file=.env.local --import tsx --test packages/ai/test/contract.test.ts
import { modelPortContract } from '@hue/core/contracts'
import { anthropicModel } from '../src/index.js'

const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY
modelPortContract('anthropic (live)', () => apiKey
  ? anthropicModel(process.env.HUE_LIVE_MODEL ?? 'claude-haiku-5-5', { apiKey, baseURL: process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL })
  : undefined)
