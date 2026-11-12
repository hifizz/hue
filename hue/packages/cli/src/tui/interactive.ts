/**
 * 交互 TUI：三段式布局（对话、编辑器、状态栏），只把 Hue 事件映射成显示。
 * 视觉对齐 Pi，不复制它的源码。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  Editor,
  Key,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  getNativeClipboard,
  isViewportTUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import { addUsage, emptyUsage } from '@hue/core'
import type { AssistantMessage, HueEvent, InputPort, InputResponse, Usage, UserMessage } from '@hue/core'
import type { SessionInfo } from '@hue/store'
import type { RunCliOptions } from '../recipe.js'
import { drain, gitBranch, openRecipe } from '../recipe.js'
import { sessionName, writeLastSession, writeSessionName } from '../session.js'
import { HueAutocompleteProvider } from './autocomplete.js'
import { HOTKEYS, SLASH_COMMANDS, SLASH_NAMES, parseShellBang, parseSlash } from './commands.js'
import { color, editorTheme, formatCwd, formatDuration, formatTokens, formatToolLine, markdownTheme, selectTheme } from './theme.js'

const shortId = (id: string) => id.slice(0, 8)

const textOf = (content: Array<{ type: string, text?: string }>): string =>
  content.map(c => (c.type === 'text' ? c.text ?? '' : '')).join('')

function userTextOf(m: UserMessage): string {
  return m.content.map(p => (p.type === 'text' ? p.text : `[${p.mediaType} file]`)).join('')
}

function assistantParts(m: AssistantMessage): { text: string, thinking: string } {
  let text = '', thinking = ''
  for (const p of m.content) {
    if (p.type === 'text') text += p.text
    else if (p.type === 'reasoning') thinking += p.text
  }
  return { text, thinking }
}

class Transcript implements Component {
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
    this.blocks.push(new Text(error ? color.red(text) : color.dim(text), 1, 0))
  }

  addUser(text: string): void {
    this.current = undefined
    this.openAssistant = false
    this.blocks.push(new Text(color.gold('You'), 1, 0))
    this.blocks.push(new Markdown(text, 1, 0, markdownTheme, { color: color.sky }))
  }

  lastAssistantText(): string | undefined {
    return this.lastText || undefined
  }

  private startAssistant(): void {
    if (this.openAssistant && this.current) return
    const md = new Markdown('', 1, 0, markdownTheme)
    const think = new Text('', 1, 0)
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
      think.setText(body ? color.dim(color.italic(body)) : '')
    }
    this.thinks.push({ refresh: refreshThink })
    this.blocks.push(think)
    this.blocks.push(md)
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
    const view = new Text('', 1, 0)
    const state = { name, args, callId, result: undefined as string | undefined, isError: false, durationMs: undefined as number | undefined }
    const refresh = () => {
      let s = formatToolLine(state.name, state.args, this.toolsExpanded)
      if (state.result !== undefined) {
        const lines = state.result.replace(/\r/g, '').split('\n')
        const shown = this.toolsExpanded ? lines : lines.slice(0, 5)
        if (shown.length) s += `\n${state.isError ? color.red(shown.join('\n')) : color.muted(shown.join('\n'))}`
        if (!this.toolsExpanded && lines.length > 5) {
          s += `\n${color.dim(`... (${lines.length - 5} more lines, Ctrl+O to expand)`)}`
        }
        if (state.durationMs !== undefined) s += `\n${color.dim(`Took ${formatDuration(state.durationMs)}`)}`
      }
      view.setText(s)
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

class Footer implements Component {
  cwd = ''
  branch?: string
  name?: string
  sessionId = ''
  modelId = ''
  usage: Usage = emptyUsage()
  contextTokens?: number
  contextWindow = 0
  busy = false

  invalidate(): void {}

  render(width: number): string[] {
    let left = formatCwd(this.cwd)
    if (this.branch) left += ` (${this.branch})`
    if (this.name) left += ` • ${this.name}`
    else left += ` • ${shortId(this.sessionId)}`
    if (this.busy) left += ' • running'
    const pwdLine = truncateToWidth(color.dim(left), width, color.dim('...'))

    const parts: string[] = []
    if (this.usage.inputTokens) parts.push(`↑${formatTokens(this.usage.inputTokens)}`)
    if (this.usage.outputTokens) parts.push(`↓${formatTokens(this.usage.outputTokens)}`)
    if (this.usage.cacheReadTokens) parts.push(`R${formatTokens(this.usage.cacheReadTokens)}`)
    if (this.usage.cacheWriteTokens) parts.push(`W${formatTokens(this.usage.cacheWriteTokens)}`)
    const window = this.contextWindow
    if (window) {
      const used = this.contextTokens
      const label = used === undefined ? `?/${formatTokens(window)}` : `${((used / window) * 100).toFixed(1)}%/${formatTokens(window)}`
      const ratio = used === undefined ? 0 : used / window
      parts.push(ratio > 0.9 ? color.red(label) : ratio > 0.7 ? color.gold(label) : label)
    }
    const statsLeft = parts.join(' ')
    const right = this.modelId
    const leftW = visibleWidth(statsLeft)
    const rightW = visibleWidth(right)
    let stats: string
    if (leftW + 2 + rightW <= width) {
      stats = statsLeft + ' '.repeat(width - leftW - rightW) + right
    } else {
      stats = truncateToWidth(`${statsLeft}  ${right}`, width, '...')
    }
    return [pwdLine, color.dim(stats)]
  }
}

async function copyText(text: string): Promise<boolean> {
  const clip = getNativeClipboard()
  if (clip?.setText) {
    try { await clip.setText(text); return true } catch { /* 再试系统命令 */ }
  }
  try {
    execFileSync('pbcopy', { input: text, stdio: ['pipe', 'pipe', 'ignore'] })
    return true
  } catch {
    try {
      execFileSync('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'pipe', 'ignore'] })
      return true
    } catch { return false }
  }
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' })
}

export async function runInteractive(opts: RunCliOptions): Promise<number> {
  const { args } = opts
  const recipe = await openRecipe(opts)
  let sessionId = recipe.sessionId
  const transcript = new Transcript()
  const footer = new Footer()
  footer.cwd = recipe.workdir
  footer.branch = gitBranch(recipe.workdir)
  footer.sessionId = sessionId
  footer.modelId = recipe.getModel().id
  footer.contextWindow = recipe.getModel().info.contextWindow
  footer.name = sessionName(args.cwd, sessionId)
  writeLastSession(args.cwd, sessionId)

  const pendingShell: string[] = []
  let running = false
  let exiting = false
  let exitCode = 0
  let overlay: OverlayHandle | undefined
  let resolveExit: () => void
  const done = new Promise<void>(r => { resolveExit = r })

  const refresh = (): void => tui.requestRender()
  const note = (text: string, error = false): void => { transcript.addSystem(text, error); refresh() }

  const terminal = new ProcessTerminal()
  const tui: TUI = args.tuiMode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal)
  const editor = new Editor(tui, editorTheme)
  editor.setAutocompleteProvider(new HueAutocompleteProvider([...SLASH_COMMANDS], args.cwd))

  const scroll = new ScrollView(transcript, { follow: 'end', primary: true, scrollbar: 'auto' })
  const body = args.tuiMode === 'regular'
    ? transcript
    : { component: scroll, grow: 1, shrink: 1, minSize: 3 }
  const root = new VStack([body, editor, footer])
  if (isViewportTUI(tui)) tui.setLayoutRoot(root)
  else tui.addChild(root)
  tui.setFocus(editor)

  const closeOverlay = (): void => {
    overlay?.hide()
    overlay = undefined
    editor.disableSubmit = false
    tui.setFocus(editor)
    refresh()
  }

  const pick = (items: SelectItem[], onPick: (item: SelectItem | undefined) => void): void => {
    closeOverlay()
    if (!items.length) { onPick(undefined); return }
    const list = new SelectList(items, Math.min(12, items.length), selectTheme)
    overlay = tui.showOverlay(list, { anchor: 'center', width: '80%', maxHeight: 16, margin: 1 })
    editor.disableSubmit = true
    const finish = (item: SelectItem | undefined) => { closeOverlay(); onPick(item) }
    list.onSelect = item => finish(item)
    list.onCancel = () => finish(undefined)
    overlay.focus()
    refresh()
  }

  const ask: InputPort['request'] = (req, signal) => new Promise<InputResponse>(resolve => {
    const finish = (response: InputResponse) => {
      signal.removeEventListener('abort', onAbort)
      closeOverlay()
      resolve(response)
    }
    const onAbort = () => finish({ action: 'cancel' })
    signal.addEventListener('abort', onAbort)
    if (req.kind !== 'approval') {
      finish({ action: 'decline', reason: 'interactive TUI only handles approval prompts' })
      return
    }
    pick([
      { value: 'accept', label: 'Allow', description: req.prompt },
      { value: 'decline', label: 'Deny' },
    ], item => {
      if (!item) finish({ action: 'cancel' })
      else if (item.value === 'accept') finish({ action: 'accept' })
      else finish({ action: 'decline' })
    })
  })

  recipe.setInput({ request: ask })

  const syncFooter = (): void => {
    footer.sessionId = sessionId
    footer.modelId = recipe.getModel().id
    footer.contextWindow = recipe.getModel().info.contextWindow
    footer.name = sessionName(args.cwd, sessionId)
    footer.busy = running
  }

  const onEvent = (e: HueEvent): void => {
    transcript.apply(e)
    if (e.type === 'turn.ended') footer.usage = addUsage(footer.usage, e.usage)
    if (e.type === 'model.message') footer.contextTokens = e.usage.inputTokens + e.usage.outputTokens + (e.usage.reasoningTokens ?? 0)
    syncFooter()
    refresh()
  }

  const replay = async (id: string): Promise<void> => {
    transcript.clear()
    footer.usage = emptyUsage()
    footer.contextTokens = undefined
    for await (const e of recipe.db.read(id)) {
      transcript.apply(e)
      if (e.type === 'turn.ended') footer.usage = addUsage(footer.usage, e.usage)
      if (e.type === 'model.message') footer.contextTokens = e.usage.inputTokens + e.usage.outputTokens + (e.usage.reasoningTokens ?? 0)
    }
    syncFooter()
  }

  const quit = async (code = 0): Promise<void> => {
    if (exiting) return
    exiting = true
    exitCode = code
    if (running) recipe.agent.interrupt(sessionId)
    closeOverlay()
    try { tui.stop() } catch { /* 已经停过 */ }
    await recipe.dispose()
    resolveExit()
  }

  const startRun = async (task: string): Promise<void> => {
    if (running) {
      recipe.agent.steer(sessionId, task)
      return
    }
    running = true
    footer.busy = true
    refresh()
    try {
      await drain(recipe.agent, task, sessionId, onEvent, opts.signal)
    } catch (err) {
      note(err instanceof Error ? err.message : String(err), true)
    } finally {
      running = false
      footer.busy = false
      writeLastSession(args.cwd, sessionId)
      refresh()
    }
  }

  const runShell = async (command: string, sendToModel: boolean): Promise<void> => {
    const bash = recipe.tools.find(t => t.name === 'bash')
    if (!bash) { note('没有 bash 工具', true); return }
    const callId = crypto.randomUUID()
    const turnId = `shell-${callId.slice(0, 8)}`
    const ac = new AbortController()
    const input = { command }
    const decision = await recipe.policy.decide({
      sessionId, turnId, callId, tool: 'bash', effects: bash.effects, input,
    }, ac.signal)
    if (decision.action === 'deny') { note(`命令被拒绝：${decision.reason}`, true); return }
    if (decision.action === 'ask') {
      const res = await ask({ kind: 'approval', prompt: decision.prompt || command, requestId: callId, sessionId, callId }, ac.signal)
      if (res.action !== 'accept') { note('命令未批准。'); return }
    }
    try {
      const parsed = bash.parse ? bash.parse(input) : input
      const out = await bash.execute(parsed, {
        signal: ac.signal,
        sessionId,
        turnId,
        callId,
        sandbox: recipe.sandbox,
        progress() {},
        requestInput: req => ask({ ...req, requestId: crypto.randomUUID(), sessionId, callId }, ac.signal),
      })
      const body = textOf(out.content)
      const block = `$ ${command}\n${body}`
      note(block, !!out.isError)
      if (sendToModel) pendingShell.push(block)
    } catch (err) {
      note(err instanceof Error ? err.message : String(err), true)
    }
  }

  const nextPrompt = (text: string): string => {
    if (!pendingShell.length) return text
    const prefix = pendingShell.join('\n\n')
    pendingShell.length = 0
    return `${prefix}\n\n${text}`
  }

  const exportSession = async (pathArg: string): Promise<void> => {
    const dest = resolve(args.cwd, pathArg || `hue-session-${shortId(sessionId)}.md`)
    if (dest.endsWith('.html')) { note('这一版只支持导出 .md 或 .jsonl，还没有 HTML。', true); return }
    const events: HueEvent[] = []
    for await (const e of recipe.db.read(sessionId)) events.push(e)
    if (dest.endsWith('.jsonl')) {
      writeFileSync(dest, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''))
    } else {
      const lines: string[] = [`# Hue session ${sessionId}`, '']
      for (const e of events) {
        if (e.type === 'user.message') lines.push('## You', '', userTextOf(e.message), '')
        else if (e.type === 'model.message') {
          const { text, thinking } = assistantParts(e.message)
          if (thinking) lines.push('## Thinking', '', thinking, '')
          if (text) lines.push('## Assistant', '', text, '')
        } else if (e.type === 'tool.call') {
          lines.push(`## Tool ${e.name}`, '', '```', JSON.stringify(e.input, null, 2), '```', '')
        } else if (e.type === 'tool.result') {
          lines.push(e.isError ? '### Error' : '### Result', '', '```', textOf(e.content), '```', '')
        }
      }
      writeFileSync(dest, lines.join('\n'))
    }
    note(`已导出到 ${dest}`)
  }

  const resumePicker = async (): Promise<void> => {
    const items: SelectItem[] = []
    const infos: SessionInfo[] = []
    for await (const s of recipe.db.sessions()) {
      if (s.parent) continue
      infos.push(s)
    }
    infos.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const s of infos) {
      const name = sessionName(args.cwd, s.sessionId)
      items.push({
        value: s.sessionId,
        label: name ?? shortId(s.sessionId),
        description: `${formatTime(s.updatedAt)}  ${s.lastSeq} events${s.sessionId === sessionId ? '  (current)' : ''}`,
      })
    }
    if (!items.length) { note('还没有可恢复的会话。'); return }
    pick(items, async item => {
      if (!item || item.value === sessionId) return
      if (running) recipe.agent.interrupt(sessionId)
      sessionId = item.value
      writeLastSession(args.cwd, sessionId)
      await replay(sessionId)
      note(`已恢复会话 ${sessionId}`)
      refresh()
    })
  }

  const handleSlash = async (name: string, rest: string): Promise<void> => {
    switch (name) {
      case 'quit':
        await quit(0)
        return
      case 'new': {
        if (running) recipe.agent.interrupt(sessionId)
        sessionId = crypto.randomUUID()
        writeLastSession(args.cwd, sessionId)
        transcript.clear()
        footer.usage = emptyUsage()
        footer.contextTokens = undefined
        syncFooter()
        note(`新会话 ${sessionId}`)
        return
      }
      case 'resume':
        await resumePicker()
        return
      case 'session': {
        const last = await recipe.db.lastSeq(sessionId)
        const lines = [
          `session  ${sessionId}`,
          `name     ${footer.name ?? '(unset)'}`,
          `db       ${recipe.dbPath}`,
          `cwd      ${recipe.workdir}`,
          `sandbox  ${args.sandbox}${recipe.copy ? `  copy ${recipe.copy}` : ''}`,
          `model    ${recipe.getModel().id}`,
          `events   ${last}`,
          `usage    ↑${formatTokens(footer.usage.inputTokens)} ↓${formatTokens(footer.usage.outputTokens)}`,
        ]
        note(lines.join('\n'))
        return
      }
      case 'model': {
        const raw = rest.replace(/^anthropic:/, '').trim()
        if (!raw) { note(`当前模型 ${recipe.getModel().id}。用法：/model <name>`); return }
        recipe.setModel(raw)
        syncFooter()
        note(`模型改为 ${recipe.getModel().id}`)
        return
      }
      case 'copy': {
        const text = transcript.lastAssistantText()
        if (!text) { note('还没有可复制的回复。', true); return }
        note(await copyText(text) ? '已复制上一条回复。' : '复制失败：找不到剪贴板。', false)
        return
      }
      case 'name': {
        if (!rest) { note(`当前会话名：${footer.name ?? '(unset)'}`); return }
        writeSessionName(args.cwd, sessionId, rest)
        syncFooter()
        note(`会话名设为 ${rest.trim()}`)
        return
      }
      case 'export':
        await exportSession(rest)
        return
      case 'hotkeys':
        note(HOTKEYS)
        return
      default:
        if (name) note(`未知命令: /${name}。输入 / 查看可用命令。`, true)
        else note(`命令：${SLASH_COMMANDS.map(c => `/${c.name}`).join(' ')}`)
    }
  }

  const handleSubmit = async (raw: string): Promise<void> => {
    const text = raw.trim()
    if (!text) return
    editor.addToHistory(raw)
    editor.setText('')
    refresh()
    const slash = parseSlash(text)
    if (slash) {
      if (slash.name && !SLASH_NAMES.has(slash.name)) {
        note(`未知命令: /${slash.name}。输入 / 查看可用命令。`, true)
        return
      }
      await handleSlash(slash.name, slash.args)
      return
    }
    const bang = parseShellBang(text)
    if (bang) {
      await runShell(bang.command, bang.sendToModel)
      return
    }
    await startRun(nextPrompt(text))
  }

  editor.onSubmit = text => { void handleSubmit(text) }

  tui.addInputListener(data => {
    if (matchesKey(data, Key.ctrl('c'))) {
      if (running) recipe.agent.interrupt(sessionId)
      else void quit(0)
      return { consume: true }
    }
    if (matchesKey(data, Key.escape)) {
      if (running) {
        recipe.agent.interrupt(sessionId)
        return { consume: true }
      }
      return
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      transcript.toolsExpanded = !transcript.toolsExpanded
      transcript.refreshTools()
      refresh()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('t'))) {
      transcript.showThinking = !transcript.showThinking
      transcript.refreshThinking()
      refresh()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('x'))) {
      void handleSlash('copy', '')
      return { consume: true }
    }
    return undefined
  })

  if (opts.signal) {
    const onAbort = () => { void quit(1) }
    if (opts.signal.aborted) { await quit(1); return 1 }
    opts.signal.addEventListener('abort', onAbort)
  }

  const existed = await recipe.db.lastSeq(sessionId) > 0
  tui.start()
  try {
    if (existed) await replay(sessionId)
    const bits = [
      `Hue  ·  ${formatCwd(recipe.workdir)}  ·  ${recipe.getModel().id}  ·  session ${shortId(sessionId)}`,
      args.sandbox === 'docker'
        ? `docker 副本 ${recipe.copy}（镜像 ${process.env.HUE_IMAGE ?? 'node:22'}）`
        : `local sandbox${args.yes ? '（--yes / yolo）' : '（coding 策略，危险命令会询问）'}`,
    ]
    if (args.continueLast && !args.session && !existed) bits.push('没有找到可继续的会话，已新建。')
    note(bits.join('\n'))
    if (args.prompt) {
      editor.addToHistory(args.prompt)
      await startRun(nextPrompt(args.prompt))
    }
    await done
    return exitCode
  } catch (err) {
    try { tui.stop() } catch { /* ignore */ }
    await recipe.dispose()
    throw err
  }
}

