export type SandboxMode = 'docker' | 'local'
export type TuiMode = 'fullscreen' | 'regular'

export interface CliArgs {
  help: boolean
  print: boolean
  json: boolean
  yes: boolean
  continueLast: boolean
  sandbox: SandboxMode
  tuiMode: TuiMode
  cwd: string
  model?: string
  session?: string
  db?: string
  prompt?: string
}

export const usage = `用法:
  hue [选项] ["<任务>"]
  hue -p [--json] [--cwd <目录>] [--sandbox docker|local] [--model <名>] [--yes] "<任务>"

  不加 -p 时进入交互 TUI（需要 TTY）。给了提示词会在打开后立刻发送。

  -p, --print         跑完一轮后退出（无界面）
  --json              每条事件一行 JSON（隐含 -p）
  -c, --continue      接着这个目录最近一次会话聊
  --cwd               工作目录，默认当前目录；docker 模式须是 git 仓库
  --sandbox           docker（默认，在仓库副本里跑）或 local（在目录本身上跑）
  --tui-mode          fullscreen（默认，和 Pi 一样用备用屏）或 regular（用终端滚动缓冲）
  --model             覆盖 HUE_MODEL；经 anthropic 兼容中转站调用
  --session           会话 id，不给就新建（或与 -c 一起用上次的）
  --db                事件库路径，默认当前目录下的 hue.db
  --yes               local 也用 yolo 策略（不再询问）。只在你清楚后果时使用。
  -h, --help          显示帮助
`

function need(argv: string[], i: number, flag: string): string {
  const v = argv[i]
  if (!v || v.startsWith('-')) throw new Error(`${flag} 需要一个参数`)
  return v
}

/** 解析 `hue` 后面的参数。`argv` 不含 node 和脚本路径。 */
export function parseArgs(argv: string[], cwd = process.cwd()): CliArgs {
  const out: CliArgs = {
    help: false, print: false, json: false, yes: false, continueLast: false,
    sandbox: 'docker', tuiMode: 'fullscreen', cwd,
  }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '-h': case '--help': out.help = true; break
      case '-p': case '--print': out.print = true; break
      case '--json': out.json = true; out.print = true; break
      case '--yes': out.yes = true; break
      case '-c': case '--continue': out.continueLast = true; break
      case '--sandbox': out.sandbox = need(argv, ++i, '--sandbox') as SandboxMode; break
      case '--tui-mode': out.tuiMode = need(argv, ++i, '--tui-mode') as TuiMode; break
      case '--cwd': out.cwd = need(argv, ++i, '--cwd'); break
      case '--model': out.model = need(argv, ++i, '--model'); break
      case '--session': out.session = need(argv, ++i, '--session'); break
      case '--db': out.db = need(argv, ++i, '--db'); break
      case '--': rest.push(...argv.slice(i + 1)); i = argv.length; break
      default:
        if (a.startsWith('-')) throw new Error(`未知选项: ${a}`)
        rest.push(a)
    }
  }
  if (out.sandbox !== 'docker' && out.sandbox !== 'local') {
    throw new Error(`--sandbox 只能是 docker 或 local，收到 "${out.sandbox}"`)
  }
  if (out.tuiMode !== 'fullscreen' && out.tuiMode !== 'regular') {
    throw new Error(`--tui-mode 只能是 fullscreen 或 regular，收到 "${out.tuiMode}"`)
  }
  const prompt = rest.join(' ').trim()
  if (prompt) out.prompt = prompt
  return out
}
