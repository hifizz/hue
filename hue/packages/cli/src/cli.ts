/**
 * `hue` 命令入口：解析参数、加载环境，交给 print 模式或交互 TUI。
 *
 *   cd hue && ./packages/cli/bin/hue.mjs --sandbox local --yes
 *   cd hue && ./packages/cli/bin/hue.mjs -p --sandbox local --yes "<任务>"
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, usage } from './args.js'
import { loadEnvFiles } from './env.js'
import { runPrint } from './recipe.js'

export async function main(argv: string[]): Promise<number> {
  let args
  try { args = parseArgs(argv) } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    console.error(usage)
    return 2
  }
  if (args.help) { console.log(usage); return 0 }

  if (args.print && !args.prompt) {
    console.error('请提供任务提示词。')
    console.error(usage)
    return 2
  }

  const cwd = resolve(args.cwd)
  if (!existsSync(cwd)) { console.error(`目录不存在: ${cwd}`); return 2 }
  args.cwd = cwd
  loadEnvFiles({ cwd })
  if (!(process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY)) {
    console.error('缺少 API key：请在 .env.local 或环境里设置 AI_GATEWAY_API_KEY（或 ANTHROPIC_API_KEY）。')
    return 2
  }

  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.on('SIGINT', onSig)
  process.on('SIGTERM', onSig)
  try {
    if (args.print) {
      const result = await runPrint({ args, signal: ac.signal })
      return result.reason === 'stop' ? 0 : 1
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('交互模式需要 TTY。无界面请用 hue -p "<任务>"。')
      return 2
    }
    const { runInteractive } = await import('./tui/interactive.js')
    return await runInteractive({ args, signal: ac.signal })
  } finally {
    process.off('SIGINT', onSig)
    process.off('SIGTERM', onSig)
  }
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => { console.error(err instanceof Error ? err.message : err); process.exit(1) },
)
