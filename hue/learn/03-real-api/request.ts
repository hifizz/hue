/**
 * 第一层：Hue 的 ModelRequest → Anthropic Messages API 的请求体。
 *
 * 这一层是第 2 课适配器的"反方向"：第 2 课把 provider 的碎片拼成我们的消息，这里把我们的消息
 * 拆回 provider 要的格式。两个方向必须互为逆运算，否则多轮对话会在第二次请求时 400。
 */
import type { Json, Message, ModelRequest } from '../02-streaming/types.js'

export interface RequestOptions {
  model: string
  /** Anthropic 的 max_tokens 是必填项，而且 thinking 的 token 也算在里面（第 0 课讲过），所以默认值要给得宽。 */
  maxTokens?: number
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 逃生口：合并进请求体最外层。provider 出新字段时不必改这个文件。 */
  extraBody?: Record<string, Json>
}

type Block = { [k: string]: Json }
type WireMessage = { role: 'user' | 'assistant'; content: Block[] }

export function toAnthropicBody(req: ModelRequest, o: RequestOptions): Record<string, Json> {
  // 新模型（官方文档：Claude 4.6 起）不支持 assistant 预填，最后一条必须是 user（tool 结果也是 user）。
  // 在本地先拦住，比等一次 400 往返更快，错误信息也更清楚。
  const last = req.messages.at(-1)
  if (!last || last.role === 'assistant') throw new Error('conversation must end with a user or tool message')

  const body: Record<string, Json> = {
    model: o.model,
    max_tokens: o.maxTokens ?? 16_000,
    stream: true,
    // 注意：这里故意没有 temperature / top_p / top_k。API 版本 2026-10-21 起这三个参数被移除，
    // 带上任何一个都是 400。
    messages: req.messages.map(toWire).filter(m => m.content.length > 0),
  }
  if (req.system) body.system = req.system
  if (req.tools.length) {
    body.tools = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
  }
  if (o.thinking) body.thinking = { type: o.thinking.type, ...(o.thinking.display ? { display: o.thinking.display } : {}) }
  if (o.effort) body.output_config = { effort: o.effort }
  return { ...body, ...o.extraBody }
}

function toWire(m: Message): WireMessage {
  switch (m.role) {
    case 'user':
      // 空文本块会被 API 拒绝，所以空串直接不发。
      return { role: 'user', content: m.content === '' ? [] : [{ type: 'text', text: m.content }] }
    case 'assistant':
      return { role: 'assistant', content: m.content.flatMap(assistantBlock) }
    case 'tool':
      // 工具结果在 API 里是一条 user 消息，里面一组 tool_result 块，用 tool_use_id 对应回 tool_use。
      return {
        role: 'user',
        content: m.content.map(r => ({
          type: 'tool_result', tool_use_id: r.callId, content: r.text, ...(r.isError ? { is_error: true } : {}),
        })),
      }
  }
}

function assistantBlock(p: Extract<Message, { role: 'assistant' }>['content'][number]): Block[] {
  switch (p.type) {
    case 'text':
      return p.text ? [{ type: 'text', text: p.text }] : []
    case 'tool-call':
      return [{ type: 'tool_use', id: p.callId, name: p.name, input: p.input }]
    case 'reasoning': {
      // 推理块必须原样发回，不能改、不能重排、不能"重新构造"，否则 400。
      // "原样"靠的是第 2 课存下的 providerMetadata：signature（普通 thinking）或 redactedData（被遮蔽的）。
      // 即使 thinking 文本是空串（display: "omitted"）也要发，因为真正被校验的是 signature。
      const a = p.providerMetadata?.anthropic
      const meta: { [k: string]: Json } = typeof a === 'object' && a !== null && !Array.isArray(a) ? a : {}
      if (typeof meta.signature === 'string') return [{ type: 'thinking', thinking: p.text, signature: meta.signature }]
      if (typeof meta.redactedData === 'string') return [{ type: 'redacted_thinking', data: meta.redactedData }]
      // 没有 Anthropic 的签名：要么来自别的 provider，要么是没收完的块。发出去只会 400，只能丢掉。
      return []
    }
  }
}
