/** 启动横幅：橙色圆角框，左边环境信息，右边提示。窄终端只留左边。 */
import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { ring } from './logo.js'
import { color } from './theme.js'

export interface BannerInfo {
  version: string
  cwd: string
  /** 左栏的 [标签, 主值, 补充]：模型、沙箱、策略、上下文、会话。 */
  rows: Array<[string, string, string?]>
  /** 装了子 agent 工具（task）才在提示里写它，没有就不写。 */
  hasTask: boolean
}

const WIDE = 96
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visibleWidth(s)))
const cell = (s: string, w: number) => ` ${pad(truncateToWidth(s, w - 2, '...'), w - 2)} `
const key = (k: string, d: string) => `${color.text(k)} ${color.muted(d)}`
const LOGO_COLS = 6
const LOGO_ROWS = 3

export class Banner implements Component {
  constructor(private info: BannerInfo) {}
  invalidate(): void {}

  render(width: number): string[] {
    const { info } = this
    const mark = ring(LOGO_COLS, LOGO_ROWS)
    const beside = [`${color.bold(color.text('Hue CLI'))} ${color.dim(`v${info.version}`)}`, color.muted(info.cwd), '']
    const left = [
      ...mark.map((l, i) => `${l}  ${beside[i]}`),
      '',
      ...info.rows.map(([k, v, more]) => `${color.muted(pad(k, 8))}${color.text(v)}${more ? color.muted(` · ${more}`) : ''}`),
    ]
    const right = width < WIDE ? [] : [
      color.orange('能做什么'),
      `${key('@', '引用文件')}  ${key('!', '直接跑命令')}`,
      ...(info.hasTask ? [key('task', '派子 agent 并行查')] : []),
      `${key('/model', '换模型')}  ${key('/resume', '接着上次')}`,
      '',
      color.gold('注意'),
      key('--yes', '会跳过所有确认'),
      color.muted('上下文快满时会自动压缩'),
    ]
    const boxW = Math.max(20, width - 2)
    const leftW = right.length ? Math.floor((boxW - 3) * 0.58) : boxW - 2
    const rightW = boxW - 3 - leftW
    const edge = color.orange
    const rows = Math.max(left.length, right.length)
    const out = [edge(`╭${'─'.repeat(boxW - 2)}╮`)]
    for (let i = 0; i < rows; i++) {
      const mid = right.length ? color.dim('│') + cell(right[i] ?? '', rightW) : ''
      out.push(`${edge('│')}${cell(left[i] ?? '', leftW)}${mid}${edge('│')}`)
    }
    out.push(edge(`╰${'─'.repeat(boxW - 2)}╯`), '')
    return out.map(l => ` ${l}`)
  }
}
