import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SandboxPort, Tool, ToolOutput } from '@hue/core'
import { toolContract } from '@hue/core/contracts'
import { bash, codingTools, edit, glob, grep, list, read, write } from '../src/index.js'
import { parseArgs, resolvePath, truncate } from '../src/builtin/util.js'
import { ctxWith, fakeSandbox, ok } from './fake-sandbox.js'
import { localSandbox, pathWithoutRg } from './local-sandbox.js'

const textOf = (o: ToolOutput) => o.content.map(c => (c.type === 'text' ? c.text : '')).join('')
/** parse + execute，和 core loop 的调用方式一致。 */
const call = async (t: Tool, input: unknown, sb: SandboxPort = fakeSandbox(), signal?: AbortSignal) =>
  t.execute(t.parse ? t.parse(input as never) : input as never, ctxWith(sb, signal ? { signal } : {}))

// ═════════ 合同 ═════════

const seeded = () => fakeSandbox({ 'a.txt': 'one\ntwo\n', 'src/x.ts': 'x', 'dir/y': 'y' }, () => ok('a.txt\n'))
const samples: Array<[Tool, unknown, unknown?]> = [
  [read(), { path: 'a.txt' }, { path: 5 }],
  [list(), {}, { path: 5 }],
  [glob(), { pattern: '*.txt' }, {}],
  [grep(), { pattern: 'one' }, {}],
  [edit(), { path: 'a.txt', old_string: 'one', new_string: '1' }, { path: 'a.txt' }],
  [write(), { path: 'n/b.txt', content: 'hi' }, { path: 'b' }],
  [bash(), { command: 'echo hi' }, { command: 1 }],
]
for (const [tool, valid, invalid] of samples) toolContract(tool, { valid: valid as never, invalid: invalid as never, ctx: () => ctxWith(seeded()) })

test('codingTools：顺序固定、名字不重复、description ≤ 600 字符、effects 符合预期', () => {
  const tools = codingTools()
  assert.deepEqual(tools.map(t => t.name), ['read', 'list', 'glob', 'grep', 'edit', 'write', 'bash'])
  for (const t of tools) assert.ok(t.description.length <= 600, `${t.name}: ${t.description.length}`)
  assert.deepEqual(Object.fromEntries(tools.map(t => [t.name, t.effects])),
    { read: 'none', list: 'none', glob: 'none', grep: 'none', edit: 'idempotent', write: 'idempotent', bash: 'unsafe' })
})

test('没有 sandbox：每个工具都返回明确的错误结果，而不是崩溃', async () => {
  for (const [tool, valid] of samples) {
    const out = await tool.execute(tool.parse!(valid as never) as never, ctxWith(undefined))
    assert.equal(out.isError, true, tool.name); assert.match(textOf(out), /needs a sandbox/, tool.name)
  }
})

// ═════════ 参数与工具函数 ═════════

test('parseArgs：错误信息告诉模型哪个参数、期望什么', () => {
  const f = { path: { type: 'string', required: true, description: '' }, n: { type: 'integer', min: 1, description: '' } } as const
  assert.deepEqual(parseArgs({ path: 'a', n: 3 }, f), { path: 'a', n: 3 })
  assert.throws(() => parseArgs({}, f), /missing required parameter "path" \(string\)/)
  assert.throws(() => parseArgs({ path: 'a', file_path: 'b' }, f), /unknown parameter "file_path"; expected: path, n/)
  assert.throws(() => parseArgs({ path: 5 }, f), /"path" must be string, got 5/)
  assert.throws(() => parseArgs({ path: 'a', n: 1.5 }, f), /"n" must be integer/)
  assert.throws(() => parseArgs({ path: 'a', n: 0 }, f), /"n" must be >= 1/)
  assert.throws(() => parseArgs([], f), /must be a JSON object/)
})

test('resolvePath：规范化 ..，相对路径接 cwd，绝对路径不动；不拦截越界（那是 sandbox 的事）', () => {
  assert.equal(resolvePath('a/../b.txt'), 'b.txt')
  assert.equal(resolvePath('a.txt', '/work'), '/work/a.txt')
  assert.equal(resolvePath('/etc/x', '/work'), '/etc/x')
  assert.equal(resolvePath('../x', '/work/sub'), '/work/x')
  assert.throws(() => resolvePath('  '), /must not be empty/)
})

test('truncate：未超限原样返回；超限时严格不超字节上限、保留头尾、写明省略量；多字节不乱码', () => {
  assert.equal(truncate('short', 100, 'h'), 'short')
  const text = `HEAD${'x'.repeat(5000)}TAIL`
  const out = truncate(text, 400, 'see more')
  assert.ok(Buffer.byteLength(out) <= 400, String(Buffer.byteLength(out)))
  assert.ok(out.startsWith('HEAD') && out.endsWith('TAIL')); assert.match(out, /omitted \d+ of 5008 bytes from the middle\. see more/)
  const cjk = truncate('你好世界'.repeat(500), 301, 'h')
  assert.ok(Buffer.byteLength(cjk) <= 301); assert.ok(!cjk.includes('�'))
  assert.ok(Buffer.byteLength(truncate(text, 400, 'h', 0.4)) <= 400)
})

// ═════════ read / list / write ═════════

test('read：带行号；文件末尾换行不产生多余空行；CRLF 显示时去掉 \\r', async () => {
  const out = textOf(await call(read(), { path: 'a.txt' }, fakeSandbox({ 'a.txt': 'one\r\ntwo\r\n' })))
  assert.equal(out, '     1\tone\n     2\ttwo')
})

test('read：offset / limit 分页，被截断时告诉模型怎么继续', async () => {
  const sb = fakeSandbox({ f: Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') })
  const out = textOf(await call(read(), { path: 'f', offset: 3, limit: 2 }, sb))
  assert.match(out, /3\tl3\n\s+4\tl4\n\[showing lines 3-4 of 10; call read again with offset=5 to continue\]/)
  assert.ok(!/continue/.test(textOf(await call(read(), { path: 'f', offset: 9 }, sb)))) // 读到末尾不再提示
})

test('read：按字节预算截断；单行超长也至少给一行；长行被截短', async () => {
  const sb = fakeSandbox({ big: Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'), long: 'y'.repeat(5000) })
  const out = textOf(await call(read({ maxOutputBytes: 1000 }), { path: 'big' }, sb))
  assert.ok(Buffer.byteLength(out) <= 1000); assert.match(out, /\[showing lines 1-\d+ of 500; call read again with offset=\d+/)
  const long = textOf(await call(read({ maxOutputBytes: 300 }), { path: 'long' }, sb))
  assert.match(long, /…\[line truncated\]/)
})

test('read：二进制、空文件、offset 越界、文件不存在', async () => {
  const sb = fakeSandbox({ bin: new Uint8Array([1, 2, 0, 3]), empty: '', f: 'a' })
  assert.match(textOf(await call(read(), { path: 'bin' }, sb)), /binary file \(4 bytes\)/)
  assert.match(textOf(await call(read(), { path: 'empty' }, sb)), /is empty/)
  const past = await call(read(), { path: 'f', offset: 5 }, sb)
  assert.equal(past.isError, true); assert.match(textOf(past), /past the end of f \(1 lines\)/)
  await assert.rejects(call(read(), { path: 'nope' }, sb), /ENOENT/)
})

test('read：cwd 选项把相对路径接到 cwd 下', async () => {
  const sb = fakeSandbox({ '/work/a.txt': 'hi' })
  assert.match(textOf(await call(read({ cwd: '/work' }), { path: 'a.txt' }, sb)), /1\thi/)
})

test('list：目录在前带 /，其余按名字排序；空目录有提示', async () => {
  const sb = fakeSandbox({ 'b.txt': '', 'a.txt': '', 'src/x': '', 'lib/y': '' })
  assert.equal(textOf(await call(list(), {}, sb)), 'lib/\nsrc/\na.txt\nb.txt')
  assert.match(textOf(await call(list(), { path: 'empty' }, sb)), /is empty/)
})

test('write：先建父目录再写；报告字节数和行数；mkdir 失败时报错而不写', async () => {
  const sb = fakeSandbox({}, () => ok())
  const out = textOf(await call(write({ cwd: '/w' }), { path: "deep/it's/f.txt", content: 'a\nb' }, sb))
  assert.match(out, /Wrote 3 bytes \(2 lines\)/)
  assert.equal(sb.text("/w/deep/it's/f.txt"), 'a\nb')
  assert.equal(sb.execs[0]!.cmd, `mkdir -p -- '/w/deep/it'\\''s'`) // 路径里的引号被转义
  const bad = fakeSandbox({}, () => ok('', 'Permission denied', 1))
  const r = await call(write(), { path: 'x/f', content: 'c' }, bad)
  assert.equal(r.isError, true); assert.equal(bad.files.size, 0)
  const flat = fakeSandbox(); await call(write(), { path: 'f', content: '' }, flat)
  assert.equal(flat.execs.length, 0) // 当前目录下的文件不需要 mkdir
})

// ═════════ edit ═════════

test('edit：成功替换一处', async () => {
  const sb = fakeSandbox({ f: 'a\nfoo(1)\nb\n' })
  const out = await call(edit(), { path: 'f', old_string: 'foo(1)', new_string: 'foo(2)' }, sb)
  assert.notEqual(out.isError, true); assert.match(textOf(out), /replaced 1 occurrence\./)
  assert.equal(sb.text('f'), 'a\nfoo(2)\nb\n')
})

test('edit：0 处匹配 → 错误；缩进不对时给出提示', async () => {
  const sb = fakeSandbox({ f: '  if (x) {\n    y()\n  }\n' })
  const miss = await call(edit(), { path: 'f', old_string: 'zzz', new_string: 'a' }, sb)
  assert.equal(miss.isError, true); assert.match(textOf(miss), /not found in f\. Check for typos/)
  const ws = await call(edit(), { path: 'f', old_string: '\n\ty()\n', new_string: 'a' }, sb)
  assert.match(textOf(ws), /ignoring|ignored/) // 去掉首尾空白后能找到 → 提示检查缩进
  assert.equal(sb.text('f'), '  if (x) {\n    y()\n  }\n') // 失败不改文件
})

test('edit：多处匹配 → 错误并说出次数；replace_all 全部替换', async () => {
  const sb = fakeSandbox({ f: 'x x x' })
  const amb = await call(edit(), { path: 'f', old_string: 'x', new_string: 'y' }, sb)
  assert.equal(amb.isError, true); assert.match(textOf(amb), /appears 3 times/); assert.equal(sb.text('f'), 'x x x')
  assert.match(textOf(await call(edit(), { path: 'f', old_string: 'x', new_string: 'y', replace_all: true }, sb)), /replaced 3 occurrences/)
  assert.equal(sb.text('f'), 'y y y')
})

test('edit：CRLF 文件用 LF 的 old_string 也能匹配，写回仍是 CRLF', async () => {
  const sb = fakeSandbox({ f: 'a\r\nb\r\nc\r\n' })
  const out = await call(edit(), { path: 'f', old_string: 'a\nb', new_string: 'A\nB\nB2' }, sb)
  assert.notEqual(out.isError, true)
  assert.equal(sb.text('f'), 'A\r\nB\r\nB2\r\nc\r\n')
})

test('edit：new_string 里的 $& $1 按字面写入；保留 BOM；删除（new_string 为空）', async () => {
  const sb = fakeSandbox({ f: '﻿price: X end' })
  await call(edit(), { path: 'f', old_string: 'X', new_string: "$& $1 $'" }, sb)
  assert.equal(sb.text('f'), "﻿price: $& $1 $' end")
  await call(edit(), { path: 'f', old_string: ' end', new_string: '' }, sb)
  assert.equal(sb.text('f'), "﻿price: $& $1 $'")
})

test('edit：空 old_string、相同内容、非 UTF-8 文件都拒绝，且不改文件', async () => {
  const bin = new Uint8Array([0xff, 0xfe, 0x41, 0x80])
  const sb = fakeSandbox({ f: 'abc', bin })
  assert.match(textOf(await call(edit(), { path: 'f', old_string: '', new_string: 'x' }, sb)), /must not be empty/)
  assert.match(textOf(await call(edit(), { path: 'f', old_string: 'a', new_string: 'a' }, sb)), /identical/)
  const r = await call(edit(), { path: 'bin', old_string: 'A', new_string: 'B' }, sb)
  assert.equal(r.isError, true); assert.match(textOf(r), /not valid UTF-8/); assert.deepEqual(sb.files.get('bin'), bin)
})

test('edit：同一调用执行第二次会失败（找不到原文）但不会改坏文件——这就是标 idempotent 的理由', async () => {
  const sb = fakeSandbox({ f: 'one' })
  const args = { path: 'f', old_string: 'one', new_string: 'two' }
  await call(edit(), args, sb)
  assert.equal((await call(edit(), args, sb)).isError, true); assert.equal(sb.text('f'), 'two')
})

// ═════════ bash ═════════

test('bash：输出格式；cwd 和超时透传给 sandbox；超时设置比 sandbox 多留余量', async () => {
  const sb = fakeSandbox({}, () => ok('hello\n', 'warn\n'))
  const tool = bash({ cwd: '/w', timeoutMs: 5000 })
  const out = await call(tool, { command: 'echo hello' }, sb)
  assert.equal(textOf(out), 'hello\n[stderr]\nwarn\n[exit code 0]'); assert.notEqual(out.isError, true)
  assert.equal(sb.execs[0]!.cmd, 'echo hello'); assert.equal(sb.execs[0]!.opts.cwd, '/w'); assert.equal(sb.execs[0]!.opts.timeoutMs, 5000)
  assert.equal(tool.timeoutMs, 15_000); assert.match(tool.description, /killed after 5s/)
})

test('bash：非零退出码是错误结果；超时说明已被杀，保留已有输出', async () => {
  const fail = await call(bash(), { command: 'x' }, fakeSandbox({}, () => ok('', 'boom', 2)))
  assert.equal(fail.isError, true); assert.match(textOf(fail), /\[exit code 2\]/)
  const slow = await call(bash({ timeoutMs: 1000 }), { command: 'sleep 9' }, fakeSandbox({}, () => ok('partial', '', 143, true)))
  assert.equal(slow.isError, true); assert.match(textOf(slow), /partial\n\[timed out after 1s and was killed\]/)
})

test('bash：输出超长被截断到上限以内，保留结尾的错误信息，提示怎么看完整内容', async () => {
  const noisy = `START\n${'log line\n'.repeat(20_000)}ERROR: the real failure`
  const out = await call(bash({ maxOutputBytes: 2000 }), { command: 'x' }, fakeSandbox({}, () => ok(noisy, '', 1)))
  const t = textOf(out)
  assert.ok(Buffer.byteLength(t) <= 2000); assert.ok(t.startsWith('START')); assert.match(t, /ERROR: the real failure\n\[exit code 1\]$/); assert.match(t, /omitted \d+ of \d+ bytes/)
  assert.match(t, /redirect it to a file and use read/)
})

test('取消：已取消的调用不产生任何 I/O；执行中的取消原样抛出', async () => {
  const sb = fakeSandbox({ f: 'x' })
  for (const [t, input] of [[read(), { path: 'f' }], [bash(), { command: 'x' }], [write(), { path: 'f', content: '' }]] as Array<[Tool, unknown]>)
    await assert.rejects(call(t, input, sb, AbortSignal.abort()), (e: any) => e?.name === 'AbortError')
  assert.equal(sb.execs.length, 0)
  const hang = fakeSandbox({}, (_c, o) => new Promise((_, rej) => o.signal!.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))))
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10)
  await assert.rejects(call(bash(), { command: 'sleep 9' }, hang, ac.signal), (e: any) => e?.name === 'AbortError')
})

// ═════════ glob / grep：命令发给真 shell ═════════

const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'hue-tools-'))
  const put = (p: string, c: string) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c) }
  put('src/a.ts', 'export const Alpha = 1\nconst beta = 2\n'); put('src/deep/b.test.ts', 'test("alpha")\n'); put('top.ts', 'alpha\n')
  put('README.md', 'Alpha docs\n'); put('node_modules/dep/index.ts', 'alpha in node_modules\n')
  return d
}
const dir = repo()
for (const [label, env] of [['rg 或默认 PATH', {}], ['没有 rg（find / grep 回退）', { PATH: pathWithoutRg() }]] as const) {
  const sb = localSandbox(env)
  const lines = (o: ToolOutput) => textOf(o).split('\n')

  test(`glob（${label}）：*.ts 匹配任意深度，跳过 node_modules，结果排序`, async () => {
    const out = await call(glob({ cwd: dir }), { pattern: '*.ts' }, sb)
    assert.deepEqual(lines(out), ['src/a.ts', 'src/deep/b.test.ts', 'top.ts'])
  })
  test(`glob（${label}）：带目录的模式；指定 path；没有匹配`, async () => {
    assert.deepEqual(lines(await call(glob({ cwd: dir }), { pattern: 'src/**/*.test.ts' }, sb)), ['src/deep/b.test.ts'])
    assert.deepEqual(lines(await call(glob({ cwd: dir }), { pattern: '*.ts', path: 'src' }, sb)).map(l => l.replace(/^src\//, '')), ['a.ts', 'deep/b.test.ts'])
    assert.match(textOf(await call(glob({ cwd: dir }), { pattern: '*.rs' }, sb)), /No files match "\*\.rs"/)
  })
  test(`grep（${label}）：path:line:text；跳过 node_modules；-i；glob 过滤`, async () => {
    const hit = textOf(await call(grep({ cwd: dir }), { pattern: 'Alpha' }, sb)).split('\n').sort()
    assert.deepEqual(hit.map(l => l.replace(/^\.\//, '')), ['README.md:1:Alpha docs', 'src/a.ts:1:export const Alpha = 1'])
    const ci = textOf(await call(grep({ cwd: dir }), { pattern: 'alpha', ignore_case: true, glob: '*.ts' }, sb))
    assert.ok(ci.includes('b.test.ts:1:test("alpha")') && ci.includes('top.ts:1:alpha') && !ci.includes('node_modules') && !ci.includes('README'))
  })
  test(`grep（${label}）：没有匹配是正常结果；正则写错是错误；单个文件也带文件名`, async () => {
    const none = await call(grep({ cwd: dir }), { pattern: 'zzz_not_here' }, sb)
    assert.notEqual(none.isError, true); assert.match(textOf(none), /No matches/)
    const bad = await call(grep({ cwd: dir }), { pattern: '(' }, sb)
    assert.equal(bad.isError, true); assert.match(textOf(bad), /search failed/)
    assert.match(textOf(await call(grep({ cwd: dir }), { pattern: 'beta', path: 'src/a.ts' }, sb)), /^(\.\/)?src\/a\.ts:2:const beta = 2$/)
  })
  test(`grep / glob（${label}）：pattern 里的引号和 shell 元字符不会被执行`, async () => {
    const marker = join(dir, 'pwned')
    await call(grep({ cwd: dir }), { pattern: `'; touch ${marker}; echo '` }, sb)
    await call(grep({ cwd: dir }), { pattern: 'x', glob: `$(touch ${marker})` }, sb)
    await call(glob({ cwd: dir }), { pattern: `*'; touch ${marker}; echo '` }, sb)
    const r = await sb.exec(`test -e ${marker}; echo $?`, { cwd: dir }); assert.equal(r.stdout.trim(), '1')
  })
}

test('grep：结果超长被截断到上限以内，并提示缩小范围', async () => {
  const sb = fakeSandbox({}, () => ok(`${'src/file.ts:1:match\n'.repeat(5000)}`))
  const t = textOf(await call(grep({ maxOutputBytes: 1000 }), { pattern: 'm' }, sb))
  assert.ok(Buffer.byteLength(t) <= 1000); assert.match(t, /more specific pattern/)
})
