/** 工具参数的 JSON 文本 → Hue 的 tool-call input。两家 provider 共用。 */
import type { Json } from '@hue/core'

/** 空串 = 无参数工具（一个参数 delta 都没来），等价 {}。解析失败（多半是被 max_tokens 截断）包成 { __raw }。 */
export function parseToolInput(raw: string): Json {
  if (raw.trim() === '') return {}
  try { return JSON.parse(raw) } catch { return { __raw: raw } }
}
