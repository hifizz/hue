/**
 * Hue 终端配色。底色取自 Pi 1.x 内置的 dark 主题（okhsl 原值），所以灰、绿、蓝、黄、红和 Pi 一致。
 * Pi 的强调色是紫色，Hue 的品牌色轮不用紫和粉，强调色换成橙（和 site/ 里的终端演示同一个橙）。
 * TODO(verify): 数值抄自 pi-mono main 分支的 theme/dark.json（2026-11-15 取），没和发布版对过。
 */
import {
  backgroundAnsi, foregroundAnsi, okhslColor, rgbColor,
  type Color, type EditorTheme, type MarkdownTheme, type SelectListTheme,
} from '@earendil-works/pi-tui'
import { homedir } from 'node:os'

// 不是 truecolor 终端（比如 macOS 自带 Terminal.app）就退到 256 色，由 pi-tui 做近似。
const mode = /truecolor|24bit/i.test(process.env.COLORTERM ?? '') ? 'truecolor' : '256color'
// 每次调用时才读 NO_COLOR（https://no-color.org），会话里改环境变量也生效，测试也好写。
const wrap = (open: string, close: string) => (s: string) => (process.env.NO_COLOR ? s : `${open}${s}${close}`)
const fg = (c: Color) => wrap(foregroundAnsi(c, mode), '\x1b[39m')
const bg = (c: Color) => wrap(backgroundAnsi(c, mode), '\x1b[49m')
const ok = (h: number, s: number, l: number) => okhslColor(h, s / 100, l / 100)

/** 任意 RGB 前景色，给 logo 的渐变用。 */
export const rgbFg = (r: number, g: number, b: number) => fg(rgbColor(Math.round(r), Math.round(g), Math.round(b)))

export const color = {
  text: fg(ok(234, 3, 89)),
  muted: fg(ok(229, 6, 67)),
  dim: fg(ok(229, 8, 56)),
  line: fg(ok(229, 8, 53)),
  bold: wrap('\x1b[1m', '\x1b[22m'),
  italic: wrap('\x1b[3m', '\x1b[23m'),
  strike: wrap('\x1b[9m', '\x1b[29m'),
  underline: wrap('\x1b[4m', '\x1b[24m'),
  orange: fg(rgbColor(255, 106, 26)),
  gold: fg(ok(83, 88, 67)),
  green: fg(ok(159, 59, 67)),
  sky: fg(ok(232, 54, 67)),
  red: fg(ok(20, 72, 67)),
}

/** 工具块的底色：新增行用 Pi 的 toolSuccessBg，删除行用 toolErrorBg。 */
export const bgAdded = bg(ok(158, 46, 25))
export const bgRemoved = bg(ok(19, 54, 25))

export const selectTheme: SelectListTheme = {
  selectedPrefix: color.orange,
  selectedText: color.orange,
  description: color.muted,
  scrollInfo: color.dim,
  noMatch: color.muted,
}

/** 输入框边框：空闲是中性灰，agent 在跑时橙色，不用看状态栏也知道现在能不能插话。 */
export const editorThemeFor = (busy: () => boolean): EditorTheme => ({
  borderColor: s => (busy() ? color.orange : color.line)(s),
  selectList: selectTheme,
})

export const markdownTheme: MarkdownTheme = {
  heading: s => color.bold(color.gold(s)),
  link: color.sky,
  linkUrl: color.dim,
  code: color.orange,
  codeBlock: color.green,
  codeBlockBorder: color.dim,
  quote: color.muted,
  quoteBorder: color.dim,
  hr: color.dim,
  listBullet: color.orange,
  bold: color.bold,
  italic: color.italic,
  strikethrough: color.strike,
  underline: color.underline,
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  return `${Math.round(count / 1_000_000)}M`
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

export type ToolStatus = 'running' | 'ok' | 'error'

/** 工具前的圆点：进行中金色，成功绿色，失败橙色，子 agent（task）蓝色。 */
export const toolDot = (status: ToolStatus, name = ''): string =>
  (status === 'error' ? color.orange : status === 'running' ? color.gold : name === 'task' ? color.sky : color.green)('●')

/** 工具调用标题：`name(参数)`。收起时参数挤在括号里，展开时每行一个。edit 只显示路径，改动在下面画 diff。 */
export function formatToolTitle(name: string, args: unknown, expanded: boolean): string {
  const title = color.text(name)
  const obj = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : undefined
  const entries = Object.entries(obj ?? { args }).filter(([k, v]) => v !== undefined && !(name === 'edit' && k !== 'path'))
  if (!entries.length || (args == null)) return title
  const text = (v: unknown) => typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  if (expanded) {
    const lines = entries.map(([k, v]) => `  ${k}: ${text(v).replace(/\t/g, '   ').replace(/\r/g, '').split('\n').join('\n    ')}`)
    return `${title}\n${color.muted(lines.join('\n'))}`
  }
  const flat = entries.map(([, v]) => text(v).replace(/\s+/g, ' ')).join(', ')
  return `${title}${color.dim('(')}${color.muted(flat.length > 80 ? `${flat.slice(0, 77)}...` : flat)}${color.dim(')')}`
}
