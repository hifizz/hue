import type { Capability, Tool, ToolContent, ToolOutput } from '@hue/core'

/** 默认给模型看的单次工具结果上限（字节）。内置工具自己已经截到 30 KB，这一道是给第三方 / MCP 工具兜底的。 */
export const MAX_TOOL_OUTPUT_BYTES = 100_000

const enc = new TextEncoder(), dec = new TextDecoder()

/** 保留头尾、中间写明省略了多少字节；按字节切，切坏的多字节字符丢掉，不留 �。结果（含提示）不超过 max。 */
function clip(text: string, max: number): string {
  const buf = enc.encode(text)
  if (buf.length <= max) return text
  const note = (omitted: number) => `\n[... ${omitted} bytes omitted by the runtime output limit (${max} bytes) ...]\n`
  const room = Math.max(0, max - enc.encode(note(buf.length)).length)
  const head = Math.ceil(room * 0.6), tail = room - head
  const a = dec.decode(buf.subarray(0, head)).replace(/�+$/, '')
  const b = dec.decode(buf.subarray(buf.length - tail)).replace(/^�+/, '')
  return a + note(buf.length - enc.encode(a).length - enc.encode(b).length) + b
}

/**
 * 限制一次工具结果里发给模型的文本总量（text 和 json 部分合计）。超出的部分保留头尾并标明省略量，isError 等原样保留。
 * 不碰 `data`（不发给模型）和文件部分（url 是引用，不是内联文本）。
 */
export function limitContent(content: ToolContent[], max: number): ToolContent[] {
  let budget = max
  return content.map((p): ToolContent => {
    if (p.type === 'file') return p
    const text = p.type === 'text' ? p.text : JSON.stringify(p.value) ?? ''
    const used = enc.encode(text).length
    if (used <= budget) { budget -= used; return p }
    const out = clip(text, Math.max(budget, 200)) // 预算耗尽后每块仍留一条能读懂的提示
    budget = 0
    return { type: 'text', text: out }
  })
}

export function limitTool(tool: Tool, max: number): Tool {
  if (!Number.isFinite(max)) return tool
  return { ...tool, async execute(input, ctx): Promise<ToolOutput> { const r = await tool.execute(input, ctx); return { ...r, content: limitContent(r.content, max) } } }
}

export function limitCapability(cap: Capability, max: number): Capability {
  if (!Number.isFinite(max) || !cap.tools) return cap
  const tools = cap.tools.bind(cap)
  return { ...cap, instructions: cap.instructions?.bind(cap), tools: async ctx => (await tools(ctx)).map(t => limitTool(t, max)) }
}
