/** 会话导出：事件 → Markdown / JSONL。纯函数，不碰文件，方便测。 */
import type { HueEvent } from '@hue/core'
import { assistantParts, textOf, userTextOf } from './tui/transcript.js'

export function sessionJsonl(events: HueEvent[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
}

export function sessionMarkdown(sessionId: string, events: HueEvent[]): string {
  const lines: string[] = [`# Hue 会话 ${sessionId}`, '']
  for (const e of events) {
    if (e.type === 'user.message') lines.push('## 你', '', userTextOf(e.message), '')
    else if (e.type === 'model.message') {
      const { text, thinking } = assistantParts(e.message)
      if (thinking) lines.push('## 思考', '', thinking, '')
      if (text) lines.push('## 助手', '', text, '')
    } else if (e.type === 'tool.call') {
      lines.push(`## 工具 ${e.name}`, '', '```', JSON.stringify(e.input, null, 2), '```', '')
    } else if (e.type === 'tool.result') {
      lines.push(e.isError ? '### 错误' : '### 结果', '', '```', textOf(e.content), '```', '')
    }
  }
  return lines.join('\n')
}
