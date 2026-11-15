/** 对话区的小部件：左侧标记列、工具块、edit 的 diff。只管排版，不碰事件。 */
import { Text, type Component } from '@earendil-works/pi-tui'
import { bgAdded, bgRemoved, color, toolDot, type ToolStatus } from './theme.js'

/** 第一行带标记（● / ❯），折行后的续行缩进对齐。`indent` 要等于标记的显示宽度。 */
export class Gutter implements Component {
  constructor(private mark: string, private inner: Component, private indent = 3) {}
  invalidate(): void { this.inner.invalidate?.() }
  render(width: number): string[] {
    const pad = ' '.repeat(this.indent)
    return this.inner.render(Math.max(1, width - this.indent)).map((line, i) => (i === 0 ? this.mark : pad) + line)
  }
}

/** edit 的改动画成 − 旧文本（红底）、+ 新文本（绿底）。工具输入里没有行号，所以不画行号。 */
export function diffRows(oldText: string, newText: string, limit: number): Component[] {
  const rows: Component[] = []
  const add = (sign: string, text: string, paint: (s: string) => string): void => {
    const lines = text.replace(/\r/g, '').replace(/\t/g, '  ').split('\n')
    for (const l of lines.slice(0, limit)) rows.push(new Text(`${sign} ${l}`, 1, 0, paint))
    if (lines.length > limit) rows.push(new Text(color.dim(`  ...（还有 ${lines.length - limit} 行）`), 1, 0, paint))
  }
  add('−', oldText, bgRemoved)
  add('+', newText, bgAdded)
  return rows
}

/** 一次工具调用：标题行、可选的 diff、可选的结果（⎿ 开头）。状态变了只改字段，渲染时现算。 */
export class ToolView implements Component {
  name = ''
  title = ''
  status: ToolStatus = 'running'
  diff: Component[] = []
  result = ''

  invalidate(): void {}
  render(width: number): string[] {
    const out = new Gutter(` ${toolDot(this.status, this.name)} `, new Text(this.title, 0, 0)).render(width)
    for (const row of this.diff) out.push(...new Gutter('     ', row, 5).render(width))
    if (this.result) out.push(...new Gutter(color.dim('   ⎿ '), new Text(this.result, 0, 0), 5).render(width))
    return out
  }
}
