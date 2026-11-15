// 每包代码行数预算（只算 src/ 下所有 .ts 的总行数，不含测试，不是单文件）。超了 CI 失败。
//
// cli 是例外：它是 UI / 交互层，要承担很多脏活（TUI 布局、斜杠命令、横幅、diff 渲染），
// 以后还要靠它去试各层 harness 的功能，行数只会涨。它不是核心，所以预算放宽到 2000，
// 不要求为了压行数去删功能。见 packages/cli/DECISIONS.md 第 9 条。
// 其他包仍然是"超了就删代码，不要调预算"。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const BUDGET = { core: 1000, ai: 900, tools: 1600, store: 500, policy: 400, sandbox: 600,
  context: 700, skills: 400, memory: 700, runtime: 1200, gateway: 800, telemetry: 400, eval: 900, cli: 2000 }
const count = d => readdirSync(d).reduce((n, f) => { const p = join(d, f)
  return n + (statSync(p).isDirectory() ? count(p) : /\.ts$/.test(f) ? readFileSync(p, 'utf8').split('\n').length : 0) }, 0)
let fail = false
for (const [pkg, max] of Object.entries(BUDGET)) {
  const src = join('packages', pkg, 'src'); if (!existsSync(src)) continue
  const n = count(src); const ok = n <= max; fail ||= !ok
  console.log(`${ok ? 'ok  ' : 'OVER'} ${pkg.padEnd(10)} ${n}/${max}`)
}
process.exit(fail ? 1 : 0)
