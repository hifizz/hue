/** 启动欢迎卡：橙色圆角边框，左栏状态、右栏用法；终端太窄时降成单列。 */
import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { color } from './theme.js'

export interface WelcomeInfo {
  version: string
  cwd: string
  model: string
  sandbox: string
  policy: string
  context: string
  session: string
}

// 色轮：顺时针 橙→金→绿→青→天蓝，再绕回，只用品牌五色。
const D = [color.orange, color.gold, color.green, color.cyan, color.sky, color.cyan, color.green, color.gold]
const dot = (i: number) => D[i]!('●')
const LOGO = [
  ` ${dot(0)}${dot(1)}${dot(2)} `,
  `${dot(7)}   ${dot(3)}`,
  ` ${dot(6)}${dot(5)}${dot(4)} `,
]

const KEY = ['模型', '沙箱', '策略', '上下文', '会话'] as const
const KEYW = Math.max(...KEY.map(k => visibleWidth(k))) + 2
const row = (k: string, v: string) => ` ${color.dim(k)}${' '.repeat(KEYW - visibleWidth(k))}${v}`

function leftLines(i: WelcomeInfo): string[] {
  return [
    `${LOGO[0]}   ${color.bold('Hue CLI')} ${color.dim(`v${i.version}`)}`,
    `${LOGO[1]}   ${color.dim(i.cwd)}`,
    `${LOGO[2]}`,
    '',
    row('模型', i.model),
    row('沙箱', i.sandbox),
    row('策略', i.policy),
    row('上下文', i.context),
    row('会话', i.session),
  ]
}

const kbd = (s: string) => color.bold(color.sky(s))
function rightLines(): string[] {
  return [
    color.orange('能做什么'),
    `${kbd('@')} 引用文件  ${kbd('!')} 直接跑命令`,
    `${kbd('task')} 派子 agent 并行查`,
    `${kbd('/model')} 换模型  ${kbd('/resume')} 接着上次`,
    '',
    color.orange('注意'),
    `${kbd('--yes')} 会跳过所有确认`,
    `上下文快满时会自动压缩`,
  ]
}

const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visibleWidth(s)))

export class WelcomeCard implements Component {
  constructor(private info: WelcomeInfo) { }
  invalidate(): void { }

  render(width: number): string[] {
    const left = leftLines(this.info), right = rightLines()
    const lw = Math.max(...left.map(visibleWidth))
    const rw = Math.max(...right.map(visibleWidth))
    const border = color.orange
    const rows: string[] = []
    if (lw + rw + 7 <= width) {
      // 两列：左状态 │ 右提示
      const n = Math.max(left.length, right.length)
      for (let i = 0; i < n; i++) {
        rows.push(` ${pad(left[i] ?? '', lw)} ${border('│')} ${pad(right[i] ?? '', rw)} `)
      }
    } else {
      const all = [...left, '', ...right]
      for (const l of all) rows.push(` ${truncateToWidth(l, width - 4, '…')} `)
    }
    const inner = Math.max(...rows.map(visibleWidth))
    const bar = border('─'.repeat(inner))
    return [
      `${border('╭')}${bar}${border('╮')}`,
      ...rows.map(r => `${border('│')}${pad(r, inner)}${border('│')}`),
      `${border('╰')}${bar}${border('╯')}`,
    ]
  }
}
