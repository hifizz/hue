// 每包代码行数预算（只算 src/，不含测试）。超了 CI 失败。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const BUDGET = { core: 1000, ai: 900, tools: 1600, store: 500, policy: 400, sandbox: 600,
  context: 700, skills: 400, memory: 700, runtime: 1200, gateway: 800, telemetry: 400, eval: 900, cli: 1800 }
const count = d => readdirSync(d).reduce((n, f) => { const p = join(d, f)
  return n + (statSync(p).isDirectory() ? count(p) : /\.ts$/.test(f) ? readFileSync(p, 'utf8').split('\n').length : 0) }, 0)
let fail = false
for (const [pkg, max] of Object.entries(BUDGET)) {
  const src = join('packages', pkg, 'src'); if (!existsSync(src)) continue
  const n = count(src); const ok = n <= max; fail ||= !ok
  console.log(`${ok ? 'ok  ' : 'OVER'} ${pkg.padEnd(10)} ${n}/${max}`)
}
process.exit(fail ? 1 : 0)
