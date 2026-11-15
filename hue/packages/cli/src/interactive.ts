/**
 * 交互 TUI 的装配：把 recipe（agent）、./tui/ 里的部件和 pi-tui 的布局接在一起。
 * 对话区、状态栏、配色在 ./tui/；导出、`!command`、横幅信息在同目录的小模块里。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  Editor,
  Key,
  ProcessTerminal,
  ScrollView,
  SelectList,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import { addUsage, emptyUsage } from '@hue/core'
import type { HueEvent, InputPort, InputResponse } from '@hue/core'
import type { SessionInfo } from '@hue/store'
import { bannerInfo } from './banner-info.js'
import { sessionJsonl, sessionMarkdown } from './export.js'
import type { RunCliOptions } from './recipe.js'
import { drain, gitBranch, openRecipe } from './recipe.js'
import { sessionName, shortId, writeLastSession, writeSessionName } from './session.js'
import { runBang } from './shell.js'
import { HueAutocompleteProvider } from './tui/autocomplete.js'
import { copyText } from './tui/clipboard.js'
import { HOTKEYS, SLASH_COMMANDS, SLASH_NAMES, helpText, parseShellBang, parseSlash, unknownSlashMessage } from './tui/commands.js'
import { Footer } from './tui/footer.js'
import { editorThemeFor, formatTokens, selectTheme } from './tui/theme.js'
import { Transcript } from './tui/transcript.js'

function formatTime(at: number): string {
  return new Date(at).toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' })
}

export async function runInteractive(opts: RunCliOptions): Promise<number> {
  const { args } = opts
  const recipe = await openRecipe(opts)
  let sessionId = recipe.sessionId
  const transcript = new Transcript()
  const footer = new Footer()
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
  const editor = new Editor(tui, editorThemeFor(() => running))
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
      { value: 'accept', label: '允许', description: req.prompt },
      { value: 'decline', label: '拒绝' },
    ], item => {
      if (!item) finish({ action: 'cancel' })
      else if (item.value === 'accept') finish({ action: 'accept' })
      else finish({ action: 'decline' })
    })
  })

  recipe.setInput({ request: ask })

  const syncFooter = (): void => {
    footer.modelId = recipe.getModel().id
    footer.contextWindow = recipe.getModel().info.contextWindow
    footer.name = sessionName(args.cwd, sessionId)
    footer.busy = running
  }

  const track = (e: HueEvent): void => {
    transcript.apply(e)
    if (e.type === 'turn.ended') footer.usage = addUsage(footer.usage, e.usage)
    if (e.type === 'model.message') footer.contextTokens = e.usage.inputTokens + e.usage.outputTokens + (e.usage.reasoningTokens ?? 0)
  }

  const onEvent = (e: HueEvent): void => {
    track(e)
    syncFooter()
    refresh()
  }

  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
  const branch = gitBranch(recipe.workdir)
  const banner = (resumed: boolean) => bannerInfo({
    recipe, version, branch, session: resumed ? `续接 ${footer.name ?? shortId(sessionId)}` : '新会话',
  })

  const replay = async (id: string): Promise<void> => {
    transcript.clear()
    transcript.addBanner(banner(true))
    footer.usage = emptyUsage()
    footer.contextTokens = undefined
    for await (const e of recipe.db.read(id)) track(e)
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
    const r = await runBang({ recipe, sessionId, command, ask })
    note(r.text, r.isError)
    if (sendToModel && r.block) pendingShell.push(r.block)
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
    writeFileSync(dest, dest.endsWith('.jsonl') ? sessionJsonl(events) : sessionMarkdown(sessionId, events))
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
        description: `${formatTime(s.updatedAt)}  ${s.lastSeq} 个事件${s.sessionId === sessionId ? '  （当前）' : ''}`,
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
        transcript.addBanner(banner(false))
        note(`新会话 ${sessionId}`)
        return
      }
      case 'resume':
        await resumePicker()
        return
      case 'session': {
        const last = await recipe.db.lastSeq(sessionId)
        const lines = [
          `会话：${sessionId}`,
          `名称：${footer.name ?? '（未设置）'}`,
          `数据库：${recipe.dbPath}`,
          `目录：${recipe.workdir}`,
          `沙箱：${args.sandbox}${recipe.copy ? `（副本 ${recipe.copy}）` : ''}`,
          `模型：${recipe.getModel().id}`,
          `事件数：${last}`,
          `用量：↑${formatTokens(footer.usage.inputTokens)} ↓${formatTokens(footer.usage.outputTokens)}`,
        ]
        note(lines.join('\n'))
        return
      }
      case 'model': {
        const raw = rest.replace(/^anthropic:/, '').trim()
        if (!raw) { note(`当前模型 ${recipe.getModel().id}。用法：/model <模型名>`); return }
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
        if (!rest) { note(`当前会话名：${footer.name ?? '（未设置）'}`); return }
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
      case 'help':
        note(helpText())
        return
      default:
        note(helpText())
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
        note(unknownSlashMessage(slash.name), true)
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
    else transcript.addBanner(banner(false))
    if (args.continueLast && !args.session && !existed) note('没有找到可继续的会话，已新建。')
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

