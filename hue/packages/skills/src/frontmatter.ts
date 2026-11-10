/**
 * SKILL.md 开头的 `---` 块。不引 YAML 库：只认 `key: value`，值可以带引号，
 * 也可以写成 `>` / `|` 之后缩进续行（描述写长时常见）——都折成一行。嵌套结构、列表不支持，会被忽略。
 */
export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src.replace(/^\uFEFF/, ''))
  if (!m) return undefined
  const meta: Record<string, string> = {}
  let key: string | undefined
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]!
      const v = kv[2]!.trim()
      meta[key] = /^[>|][+-]?$/.test(v) ? '' : v.replace(/^(["'])(.*)\1$/, '$2')
    } else if (key && /^\s+\S/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim()
  }
  return { meta, body: src.replace(/^\uFEFF/, '').slice(m[0].length) }
}
