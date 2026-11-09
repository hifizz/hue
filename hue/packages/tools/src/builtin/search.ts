import type { ExecResult, ToolOutput } from '@hue/core'
import { textResult } from '@hue/core'
import { posix } from 'node:path'
import { DEFAULT_MAX_BYTES, defineTool, quote, truncate, type ToolOptions } from './util.js'

// 和文件类工具不同，这里不把相对路径接到 cwd 上：exec 本来就在 cwd 里跑，保持相对路径，结果里的路径才短、才好读。
const searchDir = (p: string): string => { if (!p.trim()) throw new Error('path must not be empty'); return posix.normalize(p) }

/** 0 退出码且有输出 → 结果；退出码 ≤1 且没有 stderr → "没找到"（rg/grep 的 1 就是没匹配）；其他 → 错误（比如正则写错）。 */
function searchResult(r: ExecResult, none: string, max: number, hint: string): ToolOutput {
  if (r.timedOut) return textResult('search timed out; narrow the path or pattern.', true)
  if (r.exitCode === 0 && r.stdout.trim()) return textResult(truncate(r.stdout.trimEnd(), max, hint))
  if (r.exitCode <= 1 && !r.stderr.trim()) return textResult(none)
  return textResult(`search failed (exit ${r.exitCode}): ${(r.stderr.trim() || r.stdout.trim()).slice(0, 500)}`, true)
}

// 没有 rg 就退回 find / grep：开发机和最小镜像里都不一定装了 ripgrep。
// 在 shell 里判断（而不是先探测再决定）：只多一次 exec，且判断和执行在同一个环境里。
export const glob = (o: ToolOptions = {}) => defineTool<{ pattern: string; path?: string }>({
  name: 'glob',
  description: 'Find files by name pattern, e.g. "*.ts" (any depth) or "src/**/*.test.ts". Returns matching file paths, sorted. Respects .gitignore when ripgrep is available; node_modules and .git are always skipped. Use grep to search file contents.',
  effects: 'none',
  fields: {
    pattern: { type: 'string', required: true, description: 'Glob pattern. Without a "/" it matches file names at any depth.' },
    path: { type: 'string', description: 'Directory to search. Default: the working directory.' },
  },
  async run({ pattern, path = '.' }, sandbox, ctx) {
    const dir = quote(searchDir(path))
    // find 没有 **：含 "/" 的模式转成 -path（find 的 * 本来就能跨目录），不含 "/" 的用 -name。
    const findTest = pattern.includes('/') ? `-path ${quote(`*/${pattern.replace(/^\.?\//, '').replace(/\*\*\//g, '*')}`)}` : `-name ${quote(pattern)}`
    const cmd = `( if command -v rg >/dev/null 2>&1; then rg --files -g ${quote(pattern)} -g '!node_modules' -- ${dir}; else find ${dir} -type f ${findTest} -not -path '*/node_modules/*' -not -path '*/.git/*'; fi ) | sed 's|^\./||' | LC_ALL=C sort`
    const r = await sandbox.exec(cmd, { cwd: o.cwd, signal: ctx.signal })
    return searchResult({ ...r, exitCode: 0 }, `No files match "${pattern}" (searched: ${path}).`, o.maxOutputBytes ?? DEFAULT_MAX_BYTES, 'Use a more specific pattern or path.')
  },
})

export const grep = (o: ToolOptions = {}) => defineTool<{ pattern: string; path?: string; glob?: string; ignore_case?: boolean }>({
  name: 'grep',
  description: 'Search file contents with a regular expression. Returns "path:line:text" lines. Uses ripgrep when available (Rust regex syntax), otherwise grep -E (POSIX extended), so stick to common syntax. Use glob to restrict which files are searched, and glob (the tool) to find files by name.',
  effects: 'none',
  fields: {
    pattern: { type: 'string', required: true, description: 'Regular expression to search for.' },
    path: { type: 'string', description: 'File or directory to search. Default: the working directory.' },
    glob: { type: 'string', description: 'Only search files whose name matches this glob, e.g. "*.ts".' },
    ignore_case: { type: 'boolean', description: 'Case-insensitive search. Default false.' },
  },
  async run({ pattern, path = '.', glob: g, ignore_case }, sandbox, ctx) {
    const dir = quote(searchDir(path))
    const rg = `rg -nH --no-heading --color never --max-columns 300 -g '!node_modules' ${ignore_case ? '-i ' : ''}${g ? `-g ${quote(g)} ` : ''}-e ${quote(pattern)} -- ${dir}`
    const gr = `grep -rnHE ${ignore_case ? '-i ' : ''}${g ? `--include=${quote(g)} ` : ''}--exclude-dir=node_modules --exclude-dir=.git -e ${quote(pattern)} -- ${dir}`
    const r = await sandbox.exec(`if command -v rg >/dev/null 2>&1; then ${rg}; else ${gr}; fi`, { cwd: o.cwd, signal: ctx.signal })
    return searchResult(r, `No matches for "${pattern}" (searched: ${path}).`, o.maxOutputBytes ?? DEFAULT_MAX_BYTES, 'Use a more specific pattern, path or glob.')
  },
})
