/** 第一批斜杠命令：名称和用法对齐 Pi，只列入 Hue 已经有后端的那些。 */
import type { SlashCommand } from '@earendil-works/pi-tui'

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'model', description: 'Select model (opens selector UI)', argumentHint: '<provider/model>' },
  { name: 'export', description: 'Export session (Markdown default, or specify path: .md/.jsonl)' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume another session' },
  { name: 'quit', description: 'Quit Hue' },
]

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
  if (i < 0) return { name: body, args: '' }
  return { name: body.slice(0, i), args: body.slice(i).trim() }
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
