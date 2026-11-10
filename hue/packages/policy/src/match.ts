import type { Json, PolicyCall } from '@hue/core'

const globCache = new Map<string, RegExp>()

/** 工具名通配：只有 `*`（任意字符）。`fs__*` 匹配 MCP 的 `fs__read_file`。 */
export function globMatch(pattern: string, name: string): boolean {
  let re = globCache.get(pattern)
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    globCache.set(pattern, re)
  }
  return re.test(name)
}

export type Matcher = RegExp | ((value: Json | undefined) => boolean)

export function testMatcher(m: Matcher, value: Json | undefined): boolean {
  if (typeof m === 'function') return m(value)
  m.lastIndex = 0 // 带 g / y 标志的正则会记住上次位置，同样的输入第二次可能得到不同结果——违反"确定性"
  return typeof value === 'string' && m.test(value)
}

const MAX_SUMMARY = 300

/** 给人看的调用摘要：bash 显示命令本身，其他显示参数；太长截断。 */
export function summarize(call: PolicyCall): string {
  const input = call.input
  const cmd = typeof input === 'object' && input !== null && !Array.isArray(input) ? input.command : undefined
  const s = typeof cmd === 'string' ? cmd : JSON.stringify(input)
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}… (${s.length} chars)` : s
}
