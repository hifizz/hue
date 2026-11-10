import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyState, runTurn, userText } from '@hue/core'
import type { HueEvent, ModelChunk, ModelPort, ModelRequest, Tool, ToolContext } from '@hue/core'
import { fromDir, indexText, parseFrontmatter, scan } from '../src/index.js'

const tmp = () => mkdtemp(join(tmpdir(), 'hue-skills-'))
async function put(root: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) { await mkdir(join(root, p, '..'), { recursive: true }); await writeFile(join(root, p), body) }
}
const skillMd = (name: string, description: string, body = 'Do the thing.\n') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
const ctx = (): ToolContext => ({ signal: new AbortController().signal, sessionId: 's', turnId: 't', callId: 'c', progress() {}, requestInput: async () => ({ action: 'cancel' }) })
const run = async (tool: Tool, input: object) => { const out = await tool.execute(tool.parse ? tool.parse(input as never) : (input as never), ctx()); return { text: out.content.map(c => (c.type === 'text' ? c.text : '')).join(''), isError: !!out.isError } }
const loadTool = async (dir: string | string[]) => (await fromDir(dir).tools!({ sessionId: 's', turnId: 't', input: userText('x'), signal: new AbortController().signal }))[0]!

// ═════════ frontmatter ═════════

test('frontmatter：key: value、引号、> 折叠续行、CRLF、BOM；没有 frontmatter 返回 undefined；正文原样', () => {
  const r = parseFrontmatter('---\nname: pdf\ndescription: "Fill forms: quickly"\nlicense: MIT\n---\n# Body\n---\nnot frontmatter\n')!
  assert.deepEqual(r.meta, { name: 'pdf', description: 'Fill forms: quickly', license: 'MIT' }); assert.equal(r.body, '# Body\n---\nnot frontmatter\n')
  assert.equal(parseFrontmatter('---\nname: a\ndescription: >\n  first line\n  second line\n---\nx')!.meta.description, 'first line second line')
  assert.equal(parseFrontmatter('---\r\nname: a\r\ndescription: d\r\n---\r\nbody')!.meta.description, 'd')
  assert.equal(parseFrontmatter('﻿---\nname: a\n---\nb')!.meta.name, 'a')
  assert.equal(parseFrontmatter('# just markdown\n'), undefined); assert.equal(parseFrontmatter('---\nname: a\nno closing'), undefined)
  assert.deepEqual(parseFrontmatter("---\nname: 'single'\ntags:\n  - a\n---\n")!.meta.name, 'single')
})

// ═════════ scan ═════════

test('scan：合法的收下并按名字排序；不合法的记 problem 并跳过；不是目录的、没有 SKILL.md 的、不存在的目录都忽略', async () => {
  const d = await tmp()
  await put(d, {
    'b-skill/SKILL.md': skillMd('b-skill', 'second'), 'a-skill/SKILL.md': skillMd('a-skill', 'first'),
    'nofm/SKILL.md': '# no frontmatter', 'Bad_Name/SKILL.md': skillMd('Bad_Name', 'x'), 'mismatch/SKILL.md': skillMd('other', 'x'), 'nodesc/SKILL.md': '---\nname: nodesc\n---\nbody',
    'empty-dir/readme.txt': 'x', 'stray.md': 'x',
  })
  const r = await scan([d, join(d, 'does-not-exist')])
  assert.deepEqual(r.skills.map(s => s.name), ['a-skill', 'b-skill'])
  assert.equal(r.problems.length, 4)
  for (const re of [/nofm.*no frontmatter/, /Bad_Name.*lowercase/, /mismatch.*must match the directory name "mismatch"/, /nodesc.*missing description/]) assert.ok(r.problems.some(p => re.test(p)), String(re))
})

test('scan：多个目录时靠前的同名技能赢，其余照常收', async () => {
  const [project, user] = [await tmp(), await tmp()]
  await put(project, { 'deploy/SKILL.md': skillMd('deploy', 'project version') })
  await put(user, { 'deploy/SKILL.md': skillMd('deploy', 'user version'), 'notes/SKILL.md': skillMd('notes', 'user notes') })
  const r = await scan([project, user])
  assert.deepEqual(r.skills.map(s => [s.name, s.description]), [['deploy', 'project version'], ['notes', 'user notes']])
})

// ═════════ 索引 ═════════

test('索引：每个技能一行；描述压成一行并截断；开头一句说明怎么用', () => {
  const t = indexText([{ name: 'a', description: 'line one\n  line two', dir: '' }, { name: 'b', description: 'x'.repeat(500), dir: '' }], 50)
  const lines = t.split('\n')
  assert.equal(lines.length, 3); assert.match(lines[0]!, /load_skill/)
  assert.equal(lines[1], '- a: line one line two'); assert.ok(lines[2]!.length <= '- b: '.length + 50 && lines[2]!.endsWith('…'))
})

// ═════════ Capability ═════════

test('没有任何技能时：不加说明、不加工具（不白占 token）；之后新加的下一次就看得到', async () => {
  const d = await tmp(); const cap = fromDir(d); const c = { sessionId: 's', turnId: 't', input: userText('x'), signal: new AbortController().signal }
  assert.equal(await cap.instructions!(c), undefined); assert.deepEqual(await cap.tools!(c), [])
  await put(d, { 'new-one/SKILL.md': skillMd('new-one', 'appears later') })
  assert.match((await cap.instructions!(c)) as string, /- new-one: appears later/); assert.deepEqual((await cap.tools!(c)).map(t => t.name), ['load_skill'])
})

// ═════════ load_skill ═════════

async function fixture() {
  const d = await tmp()
  await put(d, {
    'pdf/SKILL.md': skillMd('pdf', 'Work with PDF files', '# PDF\nUse scripts/fill.py.\n'), 'pdf/scripts/fill.py': 'print("fill")\n', 'pdf/reference.md': 'ref text', 'pdf/.hidden': 'x', 'pdf/node_modules/x/y.js': 'x',
    'secret/SKILL.md': skillMd('secret', 'another skill'),
  })
  await put(d, { 'outside.txt': 'TOP SECRET', 'pdf-private/notes.txt': 'TOP SECRET (sibling with the same prefix)' })
  await symlink(join(d, 'outside.txt'), join(d, 'pdf/link.txt'))
  return d
}

test('load_skill：返回去掉 frontmatter 的正文和附带文件清单（不含 SKILL.md、隐藏文件、node_modules）', async () => {
  const r = await run(await loadTool(await fixture()), { name: 'pdf' })
  assert.equal(r.isError, false); assert.ok(r.text.startsWith('# PDF\nUse scripts/fill.py.'))
  assert.ok(!r.text.includes('name: pdf'))
  const listed = r.text.split('\n').filter(l => l.startsWith('- '))
  assert.deepEqual(listed, ['- link.txt', '- reference.md', '- scripts/fill.py'])
})

test('load_skill：读附带文件；没有附带文件的技能这么说', async () => {
  const d = await fixture(); const tool = await loadTool(d)
  assert.equal((await run(tool, { name: 'pdf', file: 'scripts/fill.py' })).text, 'print("fill")\n')
  assert.match((await run(tool, { name: 'secret' })).text, /No bundled files/)
})

test('load_skill：技能目录之外的一律读不到（../、绝对路径、指向目录外的符号链接）', async () => {
  const d = await fixture(); const tool = await loadTool(d)
  for (const file of ['../outside.txt', '../secret/SKILL.md', join(d, 'outside.txt'), 'link.txt', 'scripts/../../outside.txt', '../pdf-private/notes.txt']) {
    const r = await run(tool, { name: 'pdf', file })
    assert.equal(r.isError, true, file); assert.ok(!r.text.includes('TOP SECRET'), file)
  }
})

test('load_skill：不存在的技能 / 文件、目录、太大、二进制、参数错误，都是给模型看得懂的错误', async () => {
  const d = await fixture(); const tool = await loadTool(d)
  await writeFile(join(d, 'pdf/big.txt'), 'x'.repeat(100_001)); await writeFile(join(d, 'pdf/bin.dat'), Buffer.from([1, 0, 2]))
  assert.match((await run(tool, { name: 'nope' })).text, /No skill named "nope". Available: pdf, secret/)
  assert.match((await run(tool, { name: 'pdf', file: 'missing.md' })).text, /No file/)
  assert.match((await run(tool, { name: 'pdf', file: 'scripts' })).text, /not a file/)
  assert.match((await run(tool, { name: 'pdf', file: 'big.txt' })).text, /over the 100000 limit/)
  assert.match((await run(tool, { name: 'pdf', file: 'bin.dat' })).text, /binary/)
  assert.throws(() => tool.parse!({}), /non-empty/); assert.throws(() => tool.parse!({ name: 'x', file: 3 }), /string/)
})

test('load_skill 是只读的：effects none（可并发、可重跑）', async () => { assert.equal((await loadTool(await fixture())).effects, 'none') })

// ═════════ 和真 core loop 一起 ═════════

test('集成（真 core loop）：索引在系统提示里；模型调 load_skill 后，正文出现在下一次请求的工具结果里', async () => {
  const d = await fixture(); const requests: ModelRequest[] = []
  const model: ModelPort = {
    specVersion: 'hue.model.v1', id: 'mock', info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(req) {
      requests.push(structuredClone(req))
      const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 1, outputTokens: 1 } })
      if (requests.length === 1) { yield { type: 'tool-call', callId: 'c1', name: 'load_skill', input: { name: 'pdf' } }; yield fin('tool-calls') } else { yield { type: 'text-delta', text: 'ok' }; yield fin('stop') }
    },
  }
  const g = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('fill the form'), model, instructions: 'BASE', capabilities: [fromDir(d)] })
  const events: HueEvent[] = []; for (let n = await g.next(); !n.done; n = await g.next()) events.push(n.value)
  assert.ok(requests[0]!.instructions.startsWith('BASE\n\nYou have skills')); assert.match(requests[0]!.instructions, /- pdf: Work with PDF files\n- secret: another skill/)
  assert.deepEqual(requests[0]!.tools.map(t => t.name), ['load_skill'])
  assert.match(JSON.stringify(requests[1]!.messages.at(-1)), /Use scripts\/fill\.py/)
  assert.ok(!requests[0]!.instructions.includes('Use scripts/fill.py'), '正文不在索引里，只有按需加载才进上下文')
})
