/**
 * @hue/ai 的 Anthropic 适配器：Hue 的 ModelPort ← Anthropic Messages API（流式）。
 *
 * 分层（与 learn/02-streaming 同构）：
 *   http.ts             一次 POST，字节流接给 SSE，HTTP 错误 → ModelChunk.error
 *   sse.ts              字节 → SSE 消息（缓冲区攒完整事件，处理多字节字符被包边界切开）
 *   anthropic-events.ts Anthropic 事件 → ModelChunk（tool-call 攒到 block stop 才解析）
 *   convert.ts          Hue 消息 → Anthropic 请求体（system 提升、tool_result 换 role）
 *
 * 只依赖 Node 内置 fetch（Node ≥ 20.3 自带）和 @hue/core 的类型，没有第三方 SDK。
 */
import { toHueError, type ModelChunk, type ModelPort } from '@hue/core'
import { toAnthropicBody } from './convert.js'
import { anthropicHttpError, bytesFromResponse } from './http.js'
import { toModelChunks } from './anthropic-events.js'
import { parseSSE } from './sse.js'

export interface AiOptions {
  /** 默认取环境变量 ANTHROPIC_API_KEY。显式传入便于测试和多账号场景。 */
  apiKey?: string
  /** 默认 https://api.anthropic.com。测试和代理都需要能改。 */
  baseUrl?: string
  /** Anthropic Messages API 必填字段（Hue 侧没有对应概念），有默认值。 */
  maxTokens?: number
  /** 请求头里的版本号，默认仓库锁定日期的稳定版本。 */
  anthropicVersion?: string
}

/** 模型信息按 id 前缀给保守值；不知道的就写小一点，溢出错误比静默截断好诊断。 */
const MODEL_INFO: Record<string, { contextWindow: number; maxOutputTokens: number }> = {
  'claude-opus-4': { contextWindow: 200_000, maxOutputTokens: 32_000 },
  'claude-sonnet-4': { contextWindow: 200_000, maxOutputTokens: 64_000 },
  'claude-haiku-4': { contextWindow: 200_000, maxOutputTokens: 64_000 },
}
const FALLBACK_INFO = { contextWindow: 200_000, maxOutputTokens: 8_192 }

const ANTHROPIC_VERSION = '2023-06-01'

/** docs/packages/ai.md 的接口草图：ai('anthropic:claude-sonnet-4') → ModelPort。目前只认 anthropic 前缀。 */
export function ai(id: `${string}:${string}`, opts: AiOptions = {}): ModelPort | undefined {
  const sep = id.indexOf(':')
  const provider = id.slice(0, sep)
  const model = id.slice(sep + 1)
  if (provider !== 'anthropic') return undefined
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com'
  const maxTokens = opts.maxTokens ?? 8_192
  const version = opts.anthropicVersion ?? ANTHROPIC_VERSION
  const info = MODEL_INFO[model] ?? FALLBACK_INFO
  return {
    specVersion: 'hue.model.v1',
    id,
    info: {
      contextWindow: info.contextWindow,
      maxOutputTokens: info.maxOutputTokens,
      // 保守声明：images/thinking 都支持，但并行工具调用取决于具体模型，统一关掉最不容易出错。
      supports: { tools: true, parallelToolCalls: false, reasoning: true, images: true },
    },
    stream: (request, signal) => streamMessages(request, signal, { apiKey: apiKey ?? '', baseUrl, model, maxTokens, version }),
  }
}

interface CallConfig { apiKey: string; baseUrl: string; model: string; maxTokens: number; version: string }

async function* streamMessages(
  request: import('@hue/core').ModelRequest,
  signal: AbortSignal,
  cfg: CallConfig,
): AsyncGenerator<ModelChunk> {
  let body: ReturnType<typeof toAnthropicBody>
  try {
    body = toAnthropicBody(request, cfg.model, cfg.maxTokens)
  } catch (e) {
    // 请求还没发出去就发现历史里带了修不好的数据：这是调用方的错误，立刻终止流。
    yield { type: 'error', error: toHueError(e, 'invalid_tool_input') }
    return
  }

  signal.throwIfAborted()
  let res: Response
  try {
    res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': cfg.version,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    if (signal.aborted) throw e // 取消是用户意图，抛 AbortError 让上层区分，不伪装成 provider 故障
    yield { type: 'error', error: toHueError(e, 'model_error') }
    return
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    yield anthropicHttpError(res.status, text)
    return
  }

  const bytes = bytesFromResponse(res)
  if (!bytes) {
    yield { type: 'error', error: { code: 'model_error', message: 'response has no body', source: 'ai:anthropic' } }
    return
  }
  yield* toModelChunks(parseSSE(bytes))
}
