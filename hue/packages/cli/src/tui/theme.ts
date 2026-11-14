/** Hue 终端配色：橙、金、绿、青、天蓝。不用粉或紫。 */
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import { homedir } from 'node:os'

const paint = (open: string) => (s: string) => `${open}${s}\x1b[0m`

export const color = {
  dim: paint('\x1b[2m'),
  bold: paint('\x1b[1m'),
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  strike: (s: string) => `\x1b[9m${s}\x1b[0m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
  orange: paint('\x1b[38;5;208m'),
  gold: paint('\x1b[38;5;178m'),
  green: paint('\x1b[38;5;71m'),
  cyan: paint('\x1b[38;5;73m'),
  sky: paint('\x1b[38;5;74m'),
  red: paint('\x1b[38;5;167m'),
  muted: paint('\x1b[38;5;245m'),
}

export const selectTheme: SelectListTheme = {
  selectedPrefix: color.gold,
  selectedText: color.gold,
  description: color.muted,
  scrollInfo: color.dim,
  noMatch: color.muted,
}

export const editorTheme: EditorTheme = {
  borderColor: color.cyan,
  selectList: selectTheme,
}

export const markdownTheme: MarkdownTheme = {
  heading: s => color.bold(color.sky(s)),
  link: color.cyan,
  linkUrl: color.dim,
  code: color.gold,
  codeBlock: s => s,
  codeBlockBorder: color.muted,
  quote: color.muted,
  quoteBorder: color.cyan,
  hr: color.muted,
  listBullet: color.orange,
  bold: color.bold,
  italic: color.italic,
  strikethrough: color.strike,
  underline: color.underline,
}

export function formatTokens(count: number): string {
  const m = (n: number) => `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return m(count)
}

export function formatCwd(cwd: string, home = process.env.HOME ?? homedir()): string {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`
  return cwd
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const total = Math.floor(seconds)
  const minutes = Math.floor(total / 60)
  const rem = total % 60
  if (minutes < 60) return `${minutes}m ${rem}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${rem}s`
}
