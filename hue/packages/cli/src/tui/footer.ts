import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { emptyUsage } from '@hue/core'
import type { Usage } from '@hue/core'
import { color, formatTokens } from './theme.js'

/** 一行状态栏（和 site/ 里的演示一致）：左边用量和上下文占比，右边会话名和模型；运行中左边多一个橙色标记。 */
export class Footer implements Component {
  name?: string
  modelId = ''
  usage: Usage = emptyUsage()
  contextTokens?: number
  contextWindow = 0
  busy = false

  invalidate(): void {}

  render(width: number): string[] {
    const parts: string[] = []
    if (this.busy) parts.push(color.orange('运行中'))
    if (this.usage.inputTokens) parts.push(color.muted(`↑${formatTokens(this.usage.inputTokens)}`))
    if (this.usage.outputTokens) parts.push(color.muted(`↓${formatTokens(this.usage.outputTokens)}`))
    if (this.usage.cacheReadTokens) parts.push(color.muted(`R${formatTokens(this.usage.cacheReadTokens)}`))
    if (this.usage.cacheWriteTokens) parts.push(color.muted(`W${formatTokens(this.usage.cacheWriteTokens)}`))
    const window = this.contextWindow
    if (window) {
      const used = this.contextTokens
      const ratio = used === undefined ? 0 : used / window
      const paint = ratio > 0.9 ? color.red : ratio > 0.7 ? color.gold : color.green
      parts.push(used === undefined ? color.muted(`?/${formatTokens(window)}`) : `${paint(`${(ratio * 100).toFixed(1)}%`)}${color.muted(`/${formatTokens(window)}`)}`)
    }
    const left = parts.join(' ')
    const right = color.muted(this.name ? `${this.name} · ${this.modelId}` : this.modelId)
    const gap = width - visibleWidth(left) - visibleWidth(right)
    return [gap >= 2 ? left + ' '.repeat(gap) + right : truncateToWidth(`${left}  ${right}`, width, '...')]
  }
}
