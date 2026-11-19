/**
 * Hue ModelRequest → OpenAI Responses API 请求体。
 * 和 stream.ts 互为逆运算：这里把 Hue 消息拆成 input items，stream.ts 把 output items 拼回 Hue 消息。
 *
 * 选 Responses 而不是 Chat Completions：函数调用在 Responses 侧有专用的 call_id 配对，
 * 推理项（reasoning item）只有这里有，而且它是官方推荐新项目走的端点（DECISIONS 第 5 条）。
 */
import type { FilePart, JsonObject, Json, Message, ModelRequest, ToolContent } from '@hue/core'

type Item = JsonObject

export interface RequestOptions {
  model: string
  /** 上限；实际值取 min(settings.maxOutputTokens, 上限)。 */
  maxOutputTokens: number
  /** 'none' 发 reasoning: { effort: 'none' }（关闭思考）。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none'
}

export function toOpenAIBody(req: ModelRequest, o: RequestOptions): JsonObject {
  const body: JsonObject = { model: o.model, stream: true, input: toInput(req.messages) }
  if (req.settings?.maxOutputTokens) body.max_output_tokens = Math.min(req.settings.maxOutputTokens, o.maxOutputTokens)
  if (req.instructions) body.instructions = req.instructions
  if (o.effort) body.reasoning = { effort: o.effort }
  if (req.tools.length) {
    body.tools = req.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }))
    body.tool_choice = toolChoice(req.toolChoice)
  }
  // 无状态：推理的加密内容在 reasoning-end 的 providerMetadata 里由调用方原样带回（store 默认 true，中转不一定存）。
  body.store = false
  // 逃生口：provider 出新字段时不必改这个文件。
  return { ...body, ...req.settings?.providerOptions?.openai as JsonObject | undefined }
}

/** 裸字符串 'auto'/'none'/'required'；对象形式只用于强制指定某个函数（对象里没有 'auto' 这个 type）。 */
function toolChoice(c: ModelRequest['toolChoice']): Json {
  if (c === undefined || c === 'auto') return 'auto'
  if (c === 'none') return 'none'
  if (c === 'required') return 'required'
  return { type: 'function', name: c.name }
}

function toInput(messages: Message[]): Item[] {
  const out: Item[] = []
  for (const m of messages)
    for (const item of toItems(m)) {
      // 空文本/空推理不会产生 item；全空的 user 消息（content: []）在这里拦住，发给 API 只会 400。
      if (item.role === 'user' && (item.content as Item[]).length === 0) continue
      out.push(item)
    }
  return out
}

function toItems(m: Message): Item[] {
  switch (m.role) {
    case 'user':
      return [{ role: 'user', content: m.content.map(contentPart) }]
    case 'tool':
      // 一个 tool 消息 = 同一步的所有结果：每条一个 function_call_output item，用 call_id 配对。
      return m.content.map(r => ({ type: 'function_call_output', call_id: r.callId, output: toolOutput(r.content) }))
    case 'assistant':
      return m.content.flatMap((p): Item[] => {
        if (p.type === 'text') return p.text ? [{ role: 'assistant', content: [{ type: 'output_text', text: p.text }] }] : []
        if (p.type === 'tool-call') return [{ type: 'function_call', call_id: p.callId, name: p.name, arguments: JSON.stringify(p.input) }]
        // 加密推理只有 stateless 才有（store:false），原样发回才能续上多轮推理。
        const openai = p.providerMetadata?.openai
        if (typeof openai?.encryptedContent === 'string') return [{ type: 'reasoning', content: [], summary: [], encrypted_content: openai.encryptedContent }]
        return [] // 明文推理（别家的、或本家没加密的）发出去会被拒绝，只能丢
      })
  }
}

/** 多段 content 拼成一段字符串。 */
const toolOutput = (cs: ToolContent[]): string => cs.map(c => c.type === 'text' ? c.text : c.type === 'json' ? JSON.stringify(c.value as Json) : `[file: ${c.url}]`).join('\n')

function contentPart(p: { type: 'text'; text: string } | FilePart): JsonObject {
  if (p.type === 'text') return { type: 'input_text', text: p.text }
  if (/^image\//.test(p.mediaType)) {
    const m = /^data:[^,]*;base64,(.*)$/s.exec(p.url)
    return { type: 'input_image', image_url: m ? `data:${p.mediaType};base64,${m[1]}` : p.url }
  }
  throw new Error(`unsupported file type: ${p.mediaType}`)
}
