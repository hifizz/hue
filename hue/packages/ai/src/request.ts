/**
 * Hue ModelRequest → Anthropic Messages API 请求体。
 * 它和 stream.ts 必须互为逆运算：stream.ts 把 provider 的碎片拼成 Hue 消息，这里把 Hue 消息拆回去。
 * 不互逆的话，多轮对话会在第二次请求时 400。
 */
import type { FilePart, Json, JsonObject, Message, ModelRequest, ToolContent } from '@hue/core'

export interface RequestOptions {
  model: string
  /** Anthropic 的 max_tokens 必填，且 thinking 的 token 也算在里面。调用方负责给出合适的值。 */
  maxTokens: number
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 在 system / 工具列表末尾 / 最后一条消息上放 cache_control 断点。 */
  cache?: boolean
}

type Block = JsonObject
type Wire = { role: 'user' | 'assistant'; content: Block[] }

const CACHE: Block = { cache_control: { type: 'ephemeral' } }

export function toAnthropicBody(req: ModelRequest, o: RequestOptions): JsonObject {
  // 新模型不支持 assistant 预填，最后一条必须是 user（tool 结果也是 user）。本地先拦住，比等一次 400 更快更清楚。
  const last = req.messages.at(-1)
  if (!last || last.role === 'assistant') throw new Error('conversation must end with a user or tool message')

  const messages = toWire(req.messages)
  // 断点放最后一条消息：agent 循环里下一步的请求 = 这一步的全部内容 + 新增，所以这个断点下一步一定命中。
  if (o.cache) { const b = messages.at(-1)?.content.at(-1); if (b) Object.assign(b, CACHE) }

  // 故意没有 temperature / top_p / top_k：API 版本 2026-10-21 起这三个参数被移除，带上任何一个都是 400。
  const body: JsonObject = { model: o.model, max_tokens: req.settings?.maxOutputTokens ?? o.maxTokens, stream: true, messages }
  if (req.instructions) body.system = [{ type: 'text', text: req.instructions, ...(o.cache ? CACHE : {}) }]
  if (req.tools.length) {
    const tools: Block[] = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
    if (o.cache) Object.assign(tools[tools.length - 1]!, CACHE)
    body.tools = tools
    body.tool_choice = toolChoice(req.toolChoice)
  }
  if (o.thinking) body.thinking = { type: o.thinking.type, ...(o.thinking.display ? { display: o.thinking.display } : {}) }
  if (o.effort) body.output_config = { effort: o.effort }
  // 逃生口：provider 出新字段时不必改这个文件。
  return { ...body, ...req.settings?.providerOptions?.anthropic as JsonObject | undefined }
}

function toolChoice(c: ModelRequest['toolChoice']): Block {
  if (c === undefined || c === 'auto') return { type: 'auto' }
  if (c === 'none') return { type: 'none' }
  if (c === 'required') return { type: 'any' }
  return { type: 'tool', name: c.name }
}

function toWire(messages: Message[]): Wire[] {
  const out: Wire[] = []
  for (const m of messages) {
    const w = toWireOne(m)
    if (w.content.length === 0) continue // 空内容会被 API 拒绝
    // tool 结果和随后的插话都是 user：合并成一条，tool_result 在前（API 要求）。
    const prev = out.at(-1)
    if (prev && prev.role === w.role) prev.content.push(...w.content)
    else out.push(w)
  }
  return out
}

function toWireOne(m: Message): Wire {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: m.content.flatMap(p => p.type === 'text' ? textBlock(p.text) : [fileBlock(p)]) }
    case 'tool':
      // 工具结果在 API 里是 user 消息里的 tool_result 块，用 tool_use_id 对应回 tool_use。
      return { role: 'user', content: m.content.map(r => ({
        type: 'tool_result', tool_use_id: r.callId, content: r.content.flatMap(toolContent), ...(r.isError ? { is_error: true } : {}),
      })) }
    case 'assistant':
      return { role: 'assistant', content: m.content.flatMap(p => {
        if (p.type === 'text') return textBlock(p.text)
        if (p.type === 'tool-call') return [{ type: 'tool_use', id: p.callId, name: p.name, input: p.input }]
        // 推理块必须原样发回。"原样"靠 stream.ts 存下的 providerMetadata：signature 或 redactedData。
        // text 为空（display: "omitted"）也要发，因为被校验的是 signature。
        const a = p.providerMetadata?.anthropic
        if (typeof a?.signature === 'string') return [{ type: 'thinking', thinking: p.text, signature: a.signature }]
        if (typeof a?.redactedData === 'string') return [{ type: 'redacted_thinking', data: a.redactedData }]
        return [] // 别家的、或没收完的推理：发出去只会 400，只能丢
      }) }
  }
}

const textBlock = (text: string): Block[] => text ? [{ type: 'text', text }] : [] // 空文本块会被 API 拒绝

function toolContent(c: ToolContent): Block[] {
  if (c.type === 'text') return textBlock(c.text)
  if (c.type === 'file') return [fileBlock(c)]
  return textBlock(JSON.stringify(c.value as Json)) // json 没有原生块，序列化成文本给模型看
}

function fileBlock(f: FilePart): Block {
  const type = f.mediaType.startsWith('image/') ? 'image' : f.mediaType === 'application/pdf' ? 'document' : undefined
  if (!type) throw new Error(`unsupported file type: ${f.mediaType}`)
  const m = /^data:[^,]*;base64,(.*)$/s.exec(f.url)
  return { type, source: m ? { type: 'base64', media_type: f.mediaType, data: m[1]! } : { type: 'url', url: f.url } }
}
