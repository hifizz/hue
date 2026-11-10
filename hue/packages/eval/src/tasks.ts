import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EvalTask } from './types.js'

export interface RepoTask {
  id: string
  tags?: string[]
  prompt: string
  /** 初始仓库。 */
  files: Record<string, string>
  /** 测试文件。agent 能看到，但判分前会被原样写回一遍，改测试蒙混过关没用。放在顶层或已存在的目录里。 */
  tests: Record<string, string>
  /** 判分命令，退出码 0 算通过。在 agent 用的执行环境里跑。 */
  run: string
  /** 一个已知的正确改法（覆盖哪些文件）。用来自检：初始状态必须不通过，改完必须通过。 */
  solution: Record<string, string>
  timeoutMs?: number
}

// 断言的消息在输出开头，测试框架的汇总在结尾，各留一半。
const headTail = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n / 2)} … ${s.slice(-n / 2)}` : s)

export function repoTask(t: RepoTask): EvalTask & { solution: Record<string, string> } {
  return {
    id: t.id, tags: t.tags, prompt: t.prompt, timeoutMs: t.timeoutMs, solution: t.solution,
    async setup(dir) {
      for (const [path, body] of Object.entries({ ...t.files, ...t.tests })) {
        await mkdir(dirname(join(dir, path)), { recursive: true })
        await writeFile(join(dir, path), body)
      }
    },
    async check({ sandbox, signal }) {
      for (const [path, body] of Object.entries(t.tests)) await sandbox.writeFile(path, body, signal)
      const r = await sandbox.exec(t.run, { timeoutMs: 60_000, signal })
      return { pass: r.exitCode === 0 && !r.timedOut, detail: r.timedOut ? 'the check command timed out' : headTail(`${r.stdout}${r.stderr}`.trim()) }
    },
  }
}

const NODE_TEST = 'node test.js'

/** 5 个小仓库，各自带测试。够验证整条流水线，远不够说明模型行为：任务数、难度、方差都还很小。 */
export function codingTasks(): Array<EvalTask & { solution: Record<string, string> }> {
  const timeouts = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, '0')}`)
  return [
    repoTask({
      id: 'fix-off-by-one', tags: ['bugfix'], run: NODE_TEST,
      prompt: 'sumTo(n) in lib.js should return 1 + 2 + … + n, but the tests in test.js fail. Find the cause and fix it.',
      files: { 'lib.js': 'exports.sumTo = n => {\n  let total = 0\n  for (let i = 1; i < n; i++) total += i\n  return total\n}\n' },
      tests: { 'test.js': "const assert = require('node:assert')\nconst { sumTo } = require('./lib.js')\nassert.strictEqual(sumTo(4), 10)\nassert.strictEqual(sumTo(1), 1)\nassert.strictEqual(sumTo(0), 0)\nconsole.log('ok')\n" },
      solution: { 'lib.js': 'exports.sumTo = n => {\n  let total = 0\n  for (let i = 1; i <= n; i++) total += i\n  return total\n}\n' },
    }),
    repoTask({
      id: 'fix-missing-await', tags: ['bugfix'], run: NODE_TEST,
      prompt: 'getName in users.js returns undefined instead of the user name. The tests in test.js show the expected behaviour. Fix it.',
      files: { 'users.js': 'exports.getName = async (db, id) => {\n  const user = db.find(id)\n  return user.name\n}\n' },
      tests: { 'test.js': "const assert = require('node:assert')\nconst { getName } = require('./users.js')\nconst db = { find: async id => ({ 1: { name: 'ada' }, 2: { name: 'grace' } })[id] }\n;(async () => {\n  assert.strictEqual(await getName(db, 1), 'ada')\n  assert.strictEqual(await getName(db, 2), 'grace')\n  console.log('ok')\n})().catch(e => { console.error(e.message); process.exit(1) })\n" },
      solution: { 'users.js': 'exports.getName = async (db, id) => {\n  const user = await db.find(id)\n  return user.name\n}\n' },
    }),
    repoTask({
      id: 'fix-wrong-name', tags: ['bugfix', 'multi-file'], run: NODE_TEST,
      prompt: 'app.render() throws when the tests in test.js run. Find out why and fix it without changing test.js.',
      files: {
        'util.js': 'exports.format_date = d => d.toISOString().slice(0, 10)\nexports.pad = (s, n) => String(s).padStart(n)\n',
        'app.js': "const { formatDate, pad } = require('./util.js')\nexports.render = (title, date) => `${pad(title, 8)} | ${formatDate(date)}`\n",
      },
      tests: { 'test.js': "const assert = require('node:assert')\nconst { render } = require('./app.js')\nassert.strictEqual(render('hi', new Date('2026-11-10T08:00:00Z')), '      hi | 2026-11-10')\nconsole.log('ok')\n" },
      solution: { 'app.js': "const { format_date, pad } = require('./util.js')\nexports.render = (title, date) => `${pad(title, 8)} | ${format_date(date)}`\n" },
    }),
    repoTask({
      id: 'add-slugify', tags: ['feature'], run: NODE_TEST,
      prompt: 'Implement slugify(text) in slug.js as described in the comment above it. Run the tests in test.js to check.',
      files: { 'slug.js': '// slugify("  Hello,   World! ") === "hello-world"\n// Lowercase; every run of letters/digits becomes one word; words are joined by a single "-"; no leading or trailing "-".\nexports.slugify = text => {\n  throw new Error("not implemented")\n}\n' },
      tests: { 'test.js': "const assert = require('node:assert')\nconst { slugify } = require('./slug.js')\nassert.strictEqual(slugify('  Hello,   World! '), 'hello-world')\nassert.strictEqual(slugify('A--B__C'), 'a-b-c')\nassert.strictEqual(slugify('Node 22 rocks'), 'node-22-rocks')\nassert.strictEqual(slugify('!!!'), '')\nassert.strictEqual(slugify(''), '')\nconsole.log('ok')\n" },
      solution: { 'slug.js': 'exports.slugify = text => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-")\n' },
    }),
    repoTask({
      id: 'change-one-of-many', tags: ['search'], run: NODE_TEST,
      prompt: 'Requests to the payments module time out after 30 seconds, which is too short. Raise the payments timeout to 60 seconds. Do not change any other module.',
      files: {
        ...Object.fromEntries(timeouts.map(m => [`modules/${m}.js`, `exports.name = '${m}'\nexports.timeoutMs = 30000\n`])),
        'modules/payments.js': "exports.name = 'payments'\nexports.timeoutMs = 30000\n",
      },
      tests: { 'test.js': `const assert = require('node:assert')\nassert.strictEqual(require('./modules/payments.js').timeoutMs, 60000)\nfor (const m of ${JSON.stringify(timeouts)}) assert.strictEqual(require('./modules/' + m + '.js').timeoutMs, 30000, m + ' must not change')\nconsole.log('ok')\n` },
      solution: { 'modules/payments.js': "exports.name = 'payments'\nexports.timeoutMs = 60000\n" },
    }),
  ]
}
