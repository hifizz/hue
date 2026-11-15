/** 对话区：把事件投影成一串可渲染的块（横幅、用户消息、助手回复、工具块、系统提示）。 */
import { Markdown, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import type { AssistantMessage, HueEvent, UserMessage } from '@hue/core'
import { Banner, type BannerInfo } from './banner.js'
import { color, formatDuration, formatTokens, formatToolTitle, markdownTheme } from './theme.js'
import { diffRows, Gutter, ToolView } from './view.js'

export const textOf = (content: Array<{ type: string, text?: string }>): string =>
  content.map(c => (c.type === 'text' ? c.text ?? '' : '')).join('')

export function userTextOf(m: UserMessage): string {
  return m.content.map(p => (p.type === 'text' ? p.text : `[${p.mediaType} 文件]`)).join('')
}

export function assistantParts(m: AssistantMessage): { text: string, thinking: string } {
  let text = '', thinking = ''
  for (const p of m.content) {
    if (p.type === 'text') text += p.text
    else if (p.type === 'reasoning') thinking += p.text
  }
  return { text, thinking }
}

export class Transcript implements Component {
  toolsExpanded = false
  showThinking = false
  private lastText = ''
  private blocks: Component[] = []
  private tools: Array<{ refresh: () => void }> = []
  private thinks: Array<{ refresh: () => void }> = []
  private openAssistant = false
  private current?: {
    text: string
    thinking: string
    set: (text: string, thinking: string) => void
  }

  invalidate(): void {
    for (const b of this.blocks) b.invalidate()
  }

  render(width: number): string[] {
    const lines: string[] = []
    for (const b of this.blocks) {
      const part = b.render(width)
      if (!part.length) continue
      if (lines.length) lines.push('')
      lines.push(...part)
    }
    return lines
  }

  clear(): void {
    this.blocks = []
    this.tools = []
    this.thinks = []
    this.openAssistant = false
    this.current = undefined
    this.lastText = ''
  }

  addSystem(text: string, error = false): void {
    this.current = undefined
    this.openAssistant = false
    this.blocks.push(new Text(error ? color.red(text) : color.muted(text), 1, 0))
  }

  addBanner(info: BannerInfo): void { this.blocks.push(new Banner(info)) }

  addUser(text: string): void {
    this.current = undefined
    this.openAssistant = false
    this.blocks.push(new Spacer(1))
    this.blocks.push(new Gutter(color.dim(' ❯ '), new Markdown(text, 0, 0, markdownTheme, { color: color.text })))
  }

  lastAssistantText(): string | undefined {
    return this.lastText || undefined
  }

  private startAssistant(): void {
    if (this.openAssistant && this.current) return
    const md = new Markdown('', 0, 0, markdownTheme, { color: color.text })
    const think = new Text('', 0, 0)
    let thinking = ''
    const entry = {
      text: '',
      thinking: '',
      set: (next: string, nextThink: string) => {
        thinking = nextThink
        entry.text = next
        entry.thinking = nextThink
        this.lastText = next
        md.setText(next)
        refreshThink()
      },
    }
    const refreshThink = () => {
      const body = this.showThinking ? thinking.trim() : ''
      think.setText(body ? color.italic(color.dim(body)) : '')
    }
    this.thinks.push({ refresh: refreshThink })
    this.blocks.push(new Gutter('   ', think))
    this.blocks.push(new Gutter(` ${color.text('●')} `, md))
    this.current = entry
    this.openAssistant = true
  }

  appendDelta(kind: 'text' | 'reasoning', delta: string): void {
    this.startAssistant()
    if (kind === 'text') this.current!.set(this.current!.text + delta, this.current!.thinking)
    else this.current!.set(this.current!.text, this.current!.thinking + delta)
  }

  finishAssistant(message: AssistantMessage): void {
    const { text, thinking } = assistantParts(message)
    if (this.openAssistant && this.current) this.current.set(text, thinking)
    else if (text || thinking) {
      this.startAssistant()
      this.current!.set(text, thinking)
    }
    this.openAssistant = false
  }

  addTool(name: string, args: unknown, callId: string): void {
    this.openAssistant = false
    const view = new ToolView()
    view.name = name
    const state = { name, args, result: undefined as string | undefined, isError: false, durationMs: undefined as number | undefined }
    const refresh = () => {
      view.status = state.result === undefined ? 'running' : state.isError ? 'error' : 'ok'
      view.title = formatToolTitle(state.name, state.args, this.toolsExpanded)
      const input = (state.args ?? {}) as { old_string?: unknown, new_string?: unknown }
      view.diff = state.name === 'edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string' && !state.isError
        ? diffRows(input.old_string, input.new_string, this.toolsExpanded ? Infinity : 6) : []
      let s = ''
      if (state.result !== undefined) {
        const lines = state.result.replace(/\r/g, '').split('\n')
        const shown = this.toolsExpanded ? lines : lines.slice(0, 3)
        s = (state.isError ? color.orange : color.muted)(shown.join('\n'))
        if (!this.toolsExpanded && lines.length > 3) s += `\n${color.dim(`...（还有 ${lines.length - 3} 行，Ctrl+O 展开）`)}`
        if (state.durationMs !== undefined) s += `\n${color.dim(`用时 ${formatDuration(state.durationMs)}`)}`
      }
      view.result = s
    }
    refresh()
    this.tools.push({ refresh })
    this.blocks.push(view)
    this.pendingTools.set(callId, { state, refresh })
  }

  private pendingTools = new Map<string, { state: { result?: string, isError: boolean, durationMs?: number }, refresh: () => void }>()

  setToolResult(callId: string, result: string, isError: boolean, durationMs: number): void {
    const item = this.pendingTools.get(callId)
    if (!item) return
    item.state.result = result
    item.state.isError = isError
    item.state.durationMs = durationMs
    item.refresh()
  }

  refreshTools(): void { for (const t of this.tools) t.refresh() }
  refreshThinking(): void { for (const t of this.thinks) t.refresh() }

  apply(e: HueEvent): void {
    switch (e.type) {
      case 'user.message':
        this.addUser(userTextOf(e.message))
        break
      case 'model.delta':
        this.appendDelta(e.kind, e.delta)
        break
      case 'model.message':
        this.finishAssistant(e.message)
        break
      case 'tool.call':
        this.addTool(e.name, e.input, e.callId)
        break
      case 'tool.result':
        this.setToolResult(e.callId, textOf(e.content), e.isError, e.durationMs)
        break
      case 'context.compacted':
        this.addSystem(`上下文已自动压缩（${e.compaction.strategy}，${formatTokens(e.compaction.tokensBefore)} → ${formatTokens(e.compaction.tokensAfter)}）`)
        break
      case 'turn.ended':
        if (e.error) this.addSystem(e.error.message, true)
        this.openAssistant = false
        break
      default:
        break
    }
  }
}
