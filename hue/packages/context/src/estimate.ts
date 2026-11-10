import type { Message, ToolContent, ToolSpec } from '@hue/core'

// 没有 tokenizer（零依赖），按字符估算，并且故意偏高：估高只会让压缩早一点触发，
// 估低要等到 API 报超窗才发现。ASCII（英文、代码）约 3.5 字符一个 token；非 ASCII（中文等）约一字一个。
// ASCII 按 3/10 个 token 算：用整数运算再除，避免 0.3 * 100 = 30.000000000000004 被 ceil 成 31。
const ASCII_PER_10 = 3
/** 图片、PDF 等文件：不展开内容，按一个固定值算。 */
const FILE_TOKENS = 1500
const MESSAGE_OVERHEAD = 4

export function textTokens(s: string): number {
  let ascii = 0, wide = 0
  for (let i = 0; i < s.length; i++) s.charCodeAt(i) < 128 ? ascii++ : wide++
  return Math.ceil((ascii * ASCII_PER_10) / 10) + wide
}

const contentTokens = (c: ToolContent): number =>
  c.type === 'text' ? textTokens(c.text) : c.type === 'json' ? textTokens(JSON.stringify(c.value)) : FILE_TOKENS

export function messageTokens(m: Message): number {
  let n = MESSAGE_OVERHEAD
  switch (m.role) {
    case 'user':
      for (const p of m.content) n += p.type === 'text' ? textTokens(p.text) : FILE_TOKENS
      break
    case 'assistant':
      for (const p of m.content) {
        if (p.type === 'text') n += textTokens(p.text)
        else if (p.type === 'reasoning') n += textTokens(p.text) + textTokens(JSON.stringify(p.providerMetadata ?? {})) // 签名也占空间
        else n += textTokens(p.name) + textTokens(JSON.stringify(p.input))
      }
      break
    case 'tool':
      for (const r of m.content) n += MESSAGE_OVERHEAD + textTokens(r.name) + r.content.reduce((t, c) => t + contentTokens(c), 0)
      break
  }
  return n
}

export const messagesTokens = (ms: readonly Message[]): number => ms.reduce((n, m) => n + messageTokens(m), 0)

/** 每一步都要发的固定部分：系统提示 + 工具说明。 */
export const fixedTokens = (instructions: string, tools: readonly ToolSpec[]): number =>
  textTokens(instructions) + textTokens(JSON.stringify(tools))
