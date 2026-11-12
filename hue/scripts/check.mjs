// 全仓类型检查：每个包、examples、learn 各跑一次 tsc -p，并行，失败的打印输出。
// 不用 `tsc -b`：各包是 noEmit、没开 composite，项目引用要求的是另一套配置，对这里没有收益。
import { readdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const projects = [
  ...readdirSync('packages').map(p => join('packages', p)),
  'examples', 'learn',
].filter(p => existsSync(join(p, 'tsconfig.json')))

const tsc = join('node_modules', '.bin', 'tsc')
const run = p => new Promise(resolve => {
  const child = spawn(tsc, ['-p', p, '--pretty', 'false'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
  child.on('error', e => resolve({ p, ok: false, out: String(e) }))
  child.on('close', code => resolve({ p, ok: code === 0, out }))
})

const results = await Promise.all(projects.map(run))
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.p}`)
  if (!r.ok) console.log(r.out.trimEnd().split('\n').map(l => `     ${l}`).join('\n'))
}
process.exit(results.every(r => r.ok) ? 0 : 1)
