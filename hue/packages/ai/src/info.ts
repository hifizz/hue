import type { ModelInfo } from '@hue/core'

// 数字来自 Anthropic 官方 Models overview（2026-11 核对）：当前四款都是 1M 上下文、128K 输出、自适应思考。
const CLAUDE_5: ModelInfo = { contextWindow: 1_000_000, maxOutputTokens: 128_000, supports: { tools: true, parallelToolCalls: true, reasoning: true, images: true } }
const KNOWN: Record<string, ModelInfo> = {
  'claude-fable-5-1': CLAUDE_5, 'claude-opus-5-5': CLAUDE_5, 'claude-sonnet-5-5': CLAUDE_5, 'claude-haiku-5-5': CLAUDE_5,
}

// 未知模型（旧版本、中转自定义名）：宁可低估。低估上下文只会让压缩早一点触发；高估会在 API 报错后才发现。
const CONSERVATIVE: ModelInfo = { contextWindow: 200_000, maxOutputTokens: 8_192, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: true } }

export const anthropicInfo = (model: string): ModelInfo => KNOWN[model] ?? CONSERVATIVE

// 数字来自官方 Models 页（2026-11 核对）；GPT-6 系输入含图像。未知模型（中转自定义名）宁可低估：低估上下文只让压缩早一点触发。
const GPT6: ModelInfo = { contextWindow: 1_050_000, maxOutputTokens: 128_000, supports: { tools: true, parallelToolCalls: true, reasoning: true, images: true } }
const OPENAI_KNOWN: Record<string, ModelInfo> = {
  'gpt-6.2-astra': GPT6, 'gpt-6.2-sol': GPT6, 'gpt-6.1-sol': GPT6, 'gpt-6.1-terra': GPT6, 'gpt-6-luna': GPT6,
}

export const openaiInfo = (model: string): ModelInfo => OPENAI_KNOWN[model] ?? { contextWindow: 200_000, maxOutputTokens: 8_192, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: true } }
