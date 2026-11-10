/**
 * Hue 中立消息 → Anthropic Messages API 请求体。
 *
 * 转换规则里最容易踩的三个坑：
 * - Anthropic 没有 system 角色的消息：instructions 走顶层 system 字段（Hue 也正好这么设计）。
 * - tool_result 必须放在 user 消息里，且要紧跟在带 tool_use 的 assistant 消息之后；
 *   一条 Hue ToolMessage（装一步的所有结果）拆成多条 Anthropic user 消息，顺序不变。
 * - assistant 里的 thinking 块带加密签名，发回时签名缺失会被拒绝——没有签名的推理块只能丢掉。
 */
import { HueFault } from '@hue/core'
import type { FilePart, Json, JsonObject, Message, ModelRequest, ToolContent, ToolSpec } from '@hue/core'

type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: JsonObject }
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: Block[]; is_error?: boolean }
type Block = TextBlock | ImageBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock

export interface AnthropicMessage { role: 'user' | 'assistant'; content: Block[] }

export interface AnthropicBody {
  model: string
  max_tokens: number
  stream: true
  system?: string
  messages: AnthropicMessage[]
  tools?: Array<{ name: string; description: string; input_schema: Json }>
  tool_choice?: { type: 'auto' } | { type: 'none' } | { type: 'any' } | { type: 'tool'; name: string }
}

export function toAnthropicBody(req: ModelRequest, model: string, defaultMaxTokens: number): AnthropicBody {
  const messages: AnthropicMessage[] = []
  for (const m of req.messages) messages.push(...convertMessage(m))
  const body: AnthropicBody = {
    model,
    max_tokens: req.settings?.maxOutputTokens ?? defaultMaxTokens,
    stream: true,
    messages,
  }
  if (req.instructions) body.system = req.instructions
  if (req.tools.length) body.tools = req.tools.map(toAnthropicTool)
  if (req.toolChoice) body.tool_choice = toAnthropicToolChoice(req.toolChoice)
  return body
}

function convertMessage(m: Message): AnthropicMessage[] {
  switch (m.role) {
    case 'user':
      return [{ role: 'user', content: m.content.map(p => (p.type === 'text' ? toTextBlock(p.text) : fileBlock(p))) }]
    case 'assistant': {
      const content: Block[] = []
      for (const p of m.content) {
        if (p.type === 'text') content.push(toTextBlock(p.text))
        else if (p.type === 'reasoning') {
          const signature = p.providerMetadata?.anthropic?.signature
          if (typeof signature === 'string') content.push({ type: 'thinking', thinking: p.text, signature })
          // 没有签名的推理块发回去会被拒，只能丢（loop 层也不该把不完整推理放进历史）。
        } else content.push(toolUseBlock(p))
      }
      return [{ role: 'assistant', content }]
    }
    case 'tool':
      // 每个 tool_result 一条 user 消息，保持与 tool-call 的对应关系
      return m.content.map(r => {
        const block: ToolResultBlock = { type: 'tool_result', tool_use_id: r.callId, content: r.content.map(toolContentBlock) }
        if (r.isError) block.is_error = true // 只有出错时才带这个键：Anthropic 会严格校验字段语义
        return { role: 'user' as const, content: [block] }
      })
  }
}

const toTextBlock = (text: string): TextBlock => ({ type: 'text', text })

function toolUseBlock(p: { callId: string; name: string; input: Json }): ToolUseBlock {
  let input = p.input
  if (typeof input === 'object' && input !== null && !Array.isArray(input) && typeof (input as { __raw?: unknown }).__raw === 'string') {
    // 历史里残留的坏参数（被截断的 JSON）：再试一次解析，还不行就明确报错，不带坏数据上网络。
    try { input = JSON.parse((input as { __raw: string }).__raw) as Json } catch {
      throw new HueFault({ code: 'invalid_tool_input', message: `cannot resend unparseable tool input for ${p.name}`, source: 'ai:anthropic' })
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HueFault({ code: 'invalid_tool_input', message: `tool_use.input must be a JSON object for ${p.name}`, source: 'ai:anthropic' })
  }
  return { type: 'tool_use', id: p.callId, name: p.name, input }
}

function toolContentBlock(c: ToolContent): Block {
  if (c.type === 'text') return toTextBlock(c.text)
  if (c.type === 'json') return toTextBlock(JSON.stringify(c.value)) // Anthropic 没有 json 块，序列化成文本
  return fileBlock(c)
}

function fileBlock(f: FilePart): ImageBlock {
  if (!f.mediaType.startsWith('image/')) {
    throw new HueFault({ code: 'internal', message: `anthropic adapter only supports image files, got ${f.mediaType}`, source: 'ai:anthropic' })
  }
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(f.url)
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1]!, data: m[2]! } }
  if (/^https?:\/\//.test(f.url)) return { type: 'image', source: { type: 'url', url: f.url } }
  throw new HueFault({ code: 'internal', message: `unsupported file url: ${f.url.slice(0, 80)}`, source: 'ai:anthropic' })
}

const toAnthropicTool = (t: ToolSpec) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })

function toAnthropicToolChoice(c: NonNullable<ModelRequest['toolChoice']>): NonNullable<AnthropicBody['tool_choice']> {
  if (c === 'auto') return { type: 'auto' }
  if (c === 'none') return { type: 'none' }
  if (c === 'required') return { type: 'any' } // Anthropic 的叫法
  return { type: 'tool', name: c.name }
}
