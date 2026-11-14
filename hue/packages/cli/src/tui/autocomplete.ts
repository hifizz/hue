/** 斜杠补全按当前行解析，避免 pi-tui 用过期前缀把默认高亮项拼进命令名。 */
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui'
import { applySlashNameCompletion } from './commands.js'

/** pi-tui 的 @ 模糊补全只认 fd，不装就整条死掉；扫 PATH 找 fd / fdfind，找不到用 Node 兜底。 */
function resolveFd(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['fd', 'fdfind']) {
      const p = join(dir, name)
      try {
        accessSync(p, constants.X_OK)
        return p
      } catch { /* 继续找 */ }
    }
  }
  return undefined
}

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const SCAN_LIMIT = 20_000
const MAX_DEPTH = 6

/** pi-tui 的打分：basename 命中优先，目录加成；排序 score→depth→length→字母序。 */
function scoreEntry(path: string, query: string, isDir: boolean): number {
  if (!query) return 1
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  const base = p.split('/').pop() ?? p
  let s = 0
  if (base.startsWith(q)) s = 100
  else if (p.startsWith(q)) s = 80
  else if (base.includes(q)) s = 50
  else if (p.includes(q)) s = 30
  if (isDir && s > 0) s += 10
  return s
}

/** Node 兜底版 @ 补全：递归扫 cwd（@dir/sub 时从 dir 起扫），形状对齐 pi-tui 的 fd 结果。 */
function fuzzyFiles(cwd: string, raw: string): AutocompleteItem[] {
  const quoted = raw.startsWith('"')
  const query = (quoted ? raw.slice(1) : raw).replace(/\\/g, '/')
  const slash = query.lastIndexOf('/')
  const scope = slash === -1 ? '' : `${query.slice(0, slash)}/`
  const baseDir = slash === -1 ? cwd : join(cwd, query.slice(0, slash))
  const q = slash === -1 ? query : query.slice(slash + 1)
  const scored: Array<{ path: string, isDir: boolean, score: number }> = []
  let scanned = 0
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++scanned > SCAN_LIMIT) return
      if (SKIP_DIRS.has(e.name)) continue
      let isDir = e.isDirectory()
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, e.name)).isDirectory()
        } catch { /* 断链当文件 */ }
      }
      const path = rel ? `${rel}/${e.name}` : e.name
      const score = scoreEntry(path, q, isDir)
      if (score > 0) scored.push({ path, isDir, score })
      if (isDir && depth < MAX_DEPTH) walk(join(dir, e.name), path, depth + 1)
    }
  }
  walk(baseDir, '', 0)
  scored.sort((a, b) =>
    b.score - a.score ||
    a.path.split('/').length - b.path.split('/').length ||
    a.path.length - b.path.length ||
    a.path.localeCompare(b.path))
  return scored.slice(0, 20).map(({ path, isDir }) => {
    const rel = `${scope}${path}`
    const base = rel.split('/').pop() ?? rel
    const full = isDir ? `${rel}/` : rel
    return {
      value: quoted ? `@"${full}"` : `@${full}`,
      label: isDir ? `${base}/` : base,
      description: rel,
    }
  })
}

export class HueAutocompleteProvider extends CombinedAutocompleteProvider {
  private fd?: string

  constructor(
    commands: (SlashCommand | AutocompleteItem)[],
    private cwd: string,
  ) {
    const fd = resolveFd()
    super(commands, cwd, fd ?? null)
    this.fd = fd
  }

  override async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal, force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const out = await super.getSuggestions(lines, cursorLine, cursorCol, options)
    if (out || this.fd || options.signal.aborted) return out
    // 没有 fd 时 super 对 @ token 永远返回 null，这里接管最后一个 @ 词
    const text = (lines[cursorLine] ?? '').slice(0, cursorCol)
    const token = /\S+$/.exec(text)?.[0] ?? ''
    if (!token.startsWith('@')) return out
    const items = fuzzyFiles(this.cwd, token.slice(1))
    return items.length ? { items, prefix: token } : out
  }

  override applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[], cursorLine: number, cursorCol: number } {
    const current = lines[cursorLine] ?? ''
    const applied = applySlashNameCompletion(current, cursorCol, item.value)
    if (applied) {
      const next = lines.slice()
      next[cursorLine] = applied.line
      return { lines: next, cursorLine, cursorCol: applied.cursorCol }
    }
    return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }
}
