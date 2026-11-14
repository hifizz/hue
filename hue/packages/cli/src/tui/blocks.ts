/**
 * 对话区条目：用户消息 `❯`，助手回复和工具调用 `●`（pending 金、成功绿、失败红、子 agent 青）。
 * 工具结果收成一行 `└` 摘要；edit 显示红绿 diff；task 展开子 agent 的工具树。
 */
import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { color, formatDuration } from './theme.js'

const clip = (s: string, n: number) => (visibleWidth(s) > n ? `${truncateToWidth(s, n - 1, '…')}` : s)
const flat = (s: string) => s.replace(/\r/g, '').replace(/\n/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

/** name(sig)：每个工具的参数各挑一两个关键的显示，其余省略。 */
export function toolSig(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'bash': return `(${flat(str(i.command) ?? '')})`
    case 'read': return `(${str(i.path) ?? ''})`
    case 'write': case 'edit': return `(${str(i.path) ?? ''})`
    case 'list': return `(${str(i.path ?? '.')})`
    case 'glob': return `("${str(i.pattern) ?? ''}"${i.path ? `, ${str(i.path)}` : ''})`
    case 'grep': return `("${str(i.pattern) ?? ''}"${i.path ? `, ${str(i.path)}` : ''}${i.glob ? `, ${str(i.glob)}` : ''})`
    case 'task': return `(${flat(str(i.task) ?? '')})`
    case 'load_skill': return `(${str(i.name) ?? ''}${i.file ? `, ${str(i.file)}` : ''})`
    case 'remember': return `(${flat(str(i.note ?? i.content ?? i.text) ?? '')})`
    case 'recall': return `("${flat(str(i.query ?? i.name) ?? '')}")`
    case 'forget': return `(${str(i.name ?? i.query) ?? ''})`
    default: {
      const entries = Object.entries(i).slice(0, 2).map(([k, v]) => `${k}=${clip(flat(str(v) ?? ''), 24)}`)
      return entries.length ? `(${entries.join(', ')})` : ''
    }
  }
}

const RED_BG = '\x1b[48;5;52m', GREEN_BG = '\x1b[48;5;22m'
const bg = (paint: string, s: string, w: number) => `${paint}${s}${' '.repeat(Math.max(0, w - visibleWidth(s)))}\x1b[0m`

/** edit 的结果：old_string/new_string 渲染成 -/+ diff 行（红绿底），没有真实行号可用。 */
function diffLines(input: unknown, width: number, expanded: boolean): string[] {
  const i = (input ?? {}) as { old_string?: string, new_string?: string }
  const oldL = (i.old_string ?? '').replace(/\r/g, '').split('\n')
  const newL = (i.new_string ?? '').replace(/\r/g, '').split('\n')
  const max = expanded ? Infinity : 6
  const lines: string[] = []
  const push = (arr: string[], mark: string, paint: string, n: number) => {
    for (const l of arr.slice(0, n)) lines.push(bg(paint, `  ${mark} ${clip(l, width - 6)}`, width - 2))
    if (arr.length > n) lines.push(`    … ${arr.length - n} more`)
  }
  push(oldL, '-', RED_BG, Math.min(oldL.length, Math.max(2, max - Math.min(newL.length, 4))))
  push(newL, '+', GREEN_BG, Math.min(newL.length, Math.max(2, max - Math.min(oldL.length, 4))))
  return lines
}

function bashSummary(text: string, isError: boolean): { line: string, isError: boolean } {
  const lines = text.replace(/\r/g, '').split('\n')
  const exit = lines.at(-1)?.match(/^\[exit code (\d+)\]$/)
  const body = lines.filter(l => l && !l.startsWith('[stderr]') && !l.startsWith('[exit code') && !l.startsWith('[timed out'))
  const tail = flat(body.at(-1) ?? '')
  if (isError) return { line: `exit ${exit?.[1] ?? '?'}${tail ? ` · ${tail}` : ''}`, isError: true }
  return { line: tail || 'done', isError: false }
}

/** 结果摘要行：读/搜/列给条数，bash 给末行+exit，write 给行数；太长等展开看全文。 */
function summaryLines(name: string, input: unknown, text: string, isError: boolean, expanded: boolean, width: number): { lines: string[], isErr: boolean } {
  const n = text ? text.replace(/\r/g, '').split('\n').length : 0
  switch (name) {
    case 'read': {
      const cut = text.match(/\[showing lines (\d+)-(\d+) of (\d+)/)
      const total = cut ? `/${cut[3]}` : ''
      return { lines: [`${cut ? cut[2] : n} lines${cut ? ` of ${total.slice(1)}` : ''}`], isErr: false }
    }
    case 'grep': {
      const m = text.match(/^No matches/)
      return { lines: [m ? 'no matches' : `${n} matches`], isErr: false }
    }
    case 'glob': case 'list': {
      const none = text.startsWith('No files') || text.includes(' is empty')
      return { lines: [none ? flat(text) : `${n} ${name === 'glob' ? 'files' : 'entries'}`], isErr: false }
    }
    case 'write': {
      const m = text.match(/\((\d+) lines\)/)
      return { lines: [m ? `${m[1]} lines` : flat(text)], isErr: isError }
    }
    case 'bash': {
      const s = bashSummary(text, isError)
      return { lines: [s.line], isErr: s.isError }
    }
    case 'edit': {
      if (isError) return { lines: [flat(text)], isErr: true }
      const m = text.match(/replaced (\d+) occurrence/)
      const count = m && m[1] !== '1' ? [`replaced ${m[1]} occurrences`] : []
      return { lines: [...count, ...diffLines(input, width, expanded)], isErr: false }
    }
    default: {
      const first = flat(text.split('\n')[0] ?? '')
      return { lines: [first || (isError ? 'error' : 'done')], isErr: isError }
    }
  }
}

export interface ToolState {
  name: string
  input: unknown
  callId: string
  done: boolean
  isError: boolean
  synthetic?: string
  durationMs?: number
  resultText: string
  /** task 专用：子 agent 的元信息和它的工具树行。 */
  taskMeta?: string
  childLines: string[]
  childTail?: string
}

export class ToolBlock implements Component {
  constructor(public state: ToolState, private allExpanded: () => boolean) { }
  invalidate(): void { }

  render(width: number): string[] {
    const s = this.state
    const expanded = this.allExpanded()
    const pending = !s.done
    const dot = s.name === 'task' ? color.sky
      : s.isError ? color.red
        : pending ? color.gold
          : color.green
    const title = `${dot('●')} ${s.name}${color.muted(clip(toolSig(s.name, s.input), width - s.name.length - 6))}`
    const lines = [truncateToWidth(title, width, '…')]
    const ind = (mark: string) => color.muted(`  ${mark} `)

    if (s.name === 'task') {
      if (s.taskMeta) lines.push(`${ind('└')}${color.muted(s.taskMeta)}`)
      for (const l of expanded ? s.childLines : s.childLines.slice(0, 6)) {
        lines.push(`${ind('├')}${truncateToWidth(color.muted(l), width - 4, '…')}`)
      }
      if (!expanded && s.childLines.length > 6) lines.push(`${ind('├')}${color.dim(`… ${s.childLines.length - 6} 更多（Ctrl+O 展开）`)}`)
      if (s.childTail) lines.push(`${ind('└')}${clip(s.childTail, width - 4)}`)
      else if (pending) lines.push(`${ind('└')}${color.dim('running…')}`)
      return lines
    }

    if (!s.done) { lines.push(`${ind('└')}${color.dim('running…')}`); return lines }
    if (s.synthetic) { lines.push(`${ind('└')}${color.red(s.synthetic)}`); return lines }
    if (expanded) {
      const body = s.resultText.replace(/\r/g, '').split('\n')
      lines.push(...body.map(l => `${ind('│')}${s.isError ? color.red(clip(l, width - 4)) : color.muted(clip(l, width - 4))}`))
      if (s.durationMs !== undefined) lines.push(`${ind('└')}${color.dim(`Took ${formatDuration(s.durationMs)}`)}`)
      return lines
    }
    const sum = summaryLines(s.name, s.input, s.resultText, s.isError, false, width)
    const paint = sum.isErr ? color.red : (s.name === 'bash' ? color.green : color.muted)
    for (const l of sum.lines.slice(0, 8)) {
      lines.push(l.startsWith('\x1b') ? `  ${l}` : `${ind('└')}${paint(clip(l, width - 4))}`)
    }
    if (sum.lines.length > 8) lines.push(`${ind('└')}${color.dim(`… ${sum.lines.length - 8} more（Ctrl+O）`)}`)
    // 耗时只跟在 `└` 摘要后面；diff 行是满宽底色，不往上贴。
    if (s.durationMs !== undefined && lines.at(-1)?.includes('└')) {
      const i = lines.length - 1
      lines[i] = `${lines[i]} ${color.dim(`· ${formatDuration(s.durationMs)}`)}`
    }
    return lines
  }
}

/** 给一段内容加首行 `glyph` 项目符号，其余行缩进两格对齐。 */
export class Bullet implements Component {
  constructor(private inner: Component, private glyph: string) { }
  invalidate(): void { this.inner.invalidate() }
  render(width: number): string[] {
    const lines = this.inner.render(Math.max(1, width - 2))
    if (!lines.length || (lines.length === 1 && lines[0] === '')) return []
    return lines.map((l, i) => (i === 0 ? `${this.glyph} ${l}` : `  ${l}`))
  }
}

/** 顺序渲染子组件，跳过全空的块（比如隐藏的 thinking）。 */
export class Seq implements Component {
  constructor(private parts: Component[]) { }
  invalidate(): void { for (const p of this.parts) p.invalidate() }
  render(width: number): string[] {
    const out: string[] = []
    for (const p of this.parts) {
      const lines = p.render(width)
      if (lines.some(l => l !== '')) out.push(...lines)
    }
    return out
  }
}
