/** 斜杠命令：名称对齐 Pi，只列入 Hue 已经有后端的那些。顺序即补全菜单顺序：先会话流转，再查看，最后退出。 */
import type { SlashCommand } from '@earendil-works/pi-tui'

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', description: '列出所有斜杠命令' },
  { name: 'new', description: '开始新会话' },
  { name: 'resume', description: '恢复另一个会话' },
  { name: 'model', description: '查看当前模型，或用 /model <模型名> 切换', argumentHint: '<模型名>' },
  { name: 'session', description: '查看会话信息和用量' },
  { name: 'name', description: '给会话起个名字' },
  { name: 'copy', description: '复制上一条回复到剪贴板' },
  { name: 'export', description: '导出会话（默认 Markdown，可指定 .md / .jsonl 路径）' },
  { name: 'hotkeys', description: '显示所有快捷键' },
  { name: 'quit', description: '退出 Hue' },
]

/** 别的 CLI 里养成的习惯：/exit、/clear 也能用，但不占补全菜单。 */
const SLASH_ALIASES: Readonly<Record<string, string>> = { exit: 'quit', clear: 'new' }

export const SLASH_NAMES = new Set(SLASH_COMMANDS.map(c => c.name))

export const HOTKEYS = `Enter            发送
Shift+Enter      换行
Escape           中断当前任务
Ctrl+O           展开或折叠工具输出
Ctrl+T           显示或隐藏思考过程
Ctrl+X           复制上一条回复（同 /copy）
Ctrl+C           运行中则中断，否则退出
@                补全文件
/                搜索命令
!command         经 bash 工具和 policy/sandbox 运行，输出纳入下次对话
!!command        经 bash 工具和 policy/sandbox 运行，不送给模型`

export function parseSlash(text: string): { name: string, args: string } | undefined {
  if (!text.startsWith('/')) return undefined
  const body = text.slice(1)
  const i = body.search(/\s/)
  const name = i < 0 ? body : body.slice(0, i)
  return { name: SLASH_ALIASES[name] ?? name, args: i < 0 ? '' : body.slice(i).trim() }
}

export function helpText(): string {
  const rows = SLASH_COMMANDS.map(c => `/${c.name.padEnd(8)}${c.description}`)
  return `${rows.join('\n')}\n\n快捷键见 /hotkeys；!command 在沙箱里跑 shell。`
}

/** 敲错时给个提示：命令名互相包含就当候选，没有就指回 /help。 */
export function unknownSlashMessage(name: string): string {
  const near = [...SLASH_NAMES].filter(n => n.includes(name) || name.includes(n))
  return `未知命令: /${name}。${near.length ? `是想输入 ${near.map(n => `/${n}`).join('、')} 吗？` : '输入 /help 查看可用命令。'}`
}

export function parseShellBang(text: string): { command: string, sendToModel: boolean } | undefined {
  if (text.startsWith('!!')) {
    const command = text.slice(2).trim()
    return command ? { command, sendToModel: false } : undefined
  }
  if (text.startsWith('!')) {
    const command = text.slice(1).trim()
    return command ? { command, sendToModel: true } : undefined
  }
  return undefined
}

/** 按当前已输入的命令名决定补全结果，避免菜单前缀过期时把默认高亮项拼进去。 */
export function resolveSlashCompletion(typed: string, selected: string): string {
  if (!typed) return selected
  if (SLASH_NAMES.has(typed)) return typed
  if (SLASH_NAMES.has(selected) && selected.startsWith(typed)) return selected
  const prefixes = [...SLASH_NAMES].filter(name => name.startsWith(typed))
  if (prefixes.length === 1) return prefixes[0] ?? typed
  return typed
}

/** 在行首斜杠命令名上应用补全。前缀以当前行为准，不依赖可能过期的 autocompletePrefix。 */
export function applySlashNameCompletion(
  line: string,
  cursorCol: number,
  selected: string,
): { line: string, cursorCol: number } | undefined {
  const before = line.slice(0, cursorCol)
  const after = line.slice(cursorCol)
  const start = before.search(/\S/)
  if (start < 0 || before[start] !== '/') return undefined
  const body = before.slice(start + 1)
  if (body.includes('/') || /\s/.test(body)) return undefined
  const name = resolveSlashCompletion(body, selected)
  const next = `${before.slice(0, start)}/${name} ${after}`
  return { line: next, cursorCol: start + name.length + 2 }
}
