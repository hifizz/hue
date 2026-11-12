import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyState, fold, runTurn, userText } from '@hue/core'
import type { HueEvent, ModelChunk, ModelPort, ModelRequest, Tool } from '@hue/core'
import { file, search, tokens } from '../src/index.js'

const tmp = () => mkdtemp(join(tmpdir(), 'hue-mem-'))
const ctx = { sessionId: 's', turnId: 't', input: userText('x'), signal: new AbortController().signal }
const tc = { signal: new AbortController().signal, sessionId: 's', turnId: 't', callId: 'c', progress() {}, requestInput: async () => ({ action: 'cancel' as const }) }
const toolOf = async (m: ReturnType<typeof file>, name: string): Promise<Tool> => (await m.tools!(ctx)).find(t => t.name === name)!
const call = async (t: Tool, input: object) => { const o = await t.execute(t.parse ? t.parse(input as never) : (input as never), tc); return { text: o.content.map(c => (c.type === 'text' ? c.text : '')).join(''), isError: !!o.isError } }
const note = (name: string, description: string, content = 'body') => ({ name, description, content })
let clock = 0; const tick = () => new Date(Date.UTC(2026, 10, 10, 0, 0, clock++))

// ═════════ 搜索 ═════════

test('tokens：英文按词，中文按单字加相邻两字', () => {
  assert.deepEqual([...tokens('Prefers TABS, not spaces')].sort(), ['not', 'prefers', 'spaces', 'tabs'])
  assert.deepEqual([...tokens('用中文回答')].sort(), ['中', '中文', '文', '文回', '用', '用中', '答', '回', '回答'].sort())
})

test('search：名字 > 描述 > 正文；名字完全一致排最前；同分新的在前；没命中的不返回；k 截断', () => {
  const d = (name: string, description: string, content: string, updated = '2026-01-01') => ({ name, description, content, updated })
  const docs = [d('tabs', 'indentation style', 'user wants tabs'), d('editor', 'uses tabs in vim', 'x'), d('misc', 'other', 'tabs appear here'), d('unrelated', 'nothing', 'nothing')]
  assert.deepEqual(search(docs, 'tabs', 10).map(x => x.name), ['tabs', 'editor', 'misc'])
  assert.deepEqual(search(docs, 'misc', 10).map(x => x.name)[0], 'misc')
  const exact = [d('prefs-b', 'prefs', 'prefs'), d('prefs', 'unrelated', 'unrelated')]
  assert.deepEqual(search(exact, 'prefs', 10).map(x => x.name), ['prefs', 'prefs-b'], '名字完全一致的排最前，即使别的笔记词命中更多')
  assert.deepEqual(search([d('a', 'same', 'same', '2026-01-01'), d('b', 'same', 'same', '2026-02-01')], 'same', 10).map(x => x.name), ['b', 'a'])
  assert.deepEqual(search(docs, 'zzz', 10), []); assert.equal(search(docs, 'tabs', 1).length, 1)
  assert.deepEqual(search([d('lang', '回答语言', '用户希望用中文回答')], '中文', 5).map(x => x.name), ['lang'], '中文能搜到')
  assert.deepEqual(search([d('x', '', '')], '', 5), [])
})

// ═════════ remember / list / forget ═════════

test('remember：写成带 frontmatter 的 markdown 文件，list 读回来；同名更新，不是追加', async () => {
  const dir = await tmp(); const m = file(dir, { now: tick })
  assert.equal(await m.remember(note('prefers-tabs', 'User prefers tabs', 'Use tabs, width 4.')), undefined)
  const src = await readFile(join(dir, 'prefers-tabs.md'), 'utf8')
  assert.match(src, /^---\nname: prefers-tabs\ndescription: User prefers tabs\nupdated: 2026-11-10T00:00:\d\d\.000Z\n---\nUse tabs, width 4\.\n$/)
  await m.remember(note('prefers-tabs', 'User prefers tabs (updated)', 'Width 2.'))
  const all = await m.list()
  assert.deepEqual(all.map(x => [x.name, x.description, x.content]), [['prefers-tabs', 'User prefers tabs (updated)', 'Width 2.']])
  assert.deepEqual((await readdir(dir)), ['prefers-tabs.md'], '没有留下临时文件')
})

test('remember 拒绝：坏名字、坏描述、空内容、太长、疑似凭证、满了——错误是写给模型看的，文件没写', async () => {
  const dir = await tmp(); const m = file(dir, { maxChars: 50, maxItems: 2 })
  const cases: Array<[Parameters<typeof m.remember>[0], RegExp]> = [
    [note('Bad Name', 'd'), /name must be/], [note('../escape', 'd'), /name must be/], [note('ok', ''), /description/], [note('ok', 'two\nlines'), /description/], [note('ok', 'x'.repeat(161)), /description/],
    [note('ok', 'd', '  '), /empty/], [note('ok', 'd', 'x'.repeat(51)), /limit is 50/],
    [note('ok', 'd', 'key: sk-abcdefghijklmnopqrstuvwxyz123456'), /secret/], [note('ok', 'd', '-----BEGIN RSA PRIVATE KEY-----'), /secret/], [note('ok', 'd', 'password = hunter2hunter2'), /secret/],
    [note('ok', 'AKIAABCDEFGHIJKLMNOP'), /secret/], [note('ok', 'd', `token ghp_${'a'.repeat(36)}`), /secret/],
  ]
  for (const [n, re] of cases) assert.match((await m.remember(n)) ?? 'accepted', re, JSON.stringify(n))
  assert.deepEqual(await m.list(), [])
  await m.remember(note('a', 'd')); await m.remember(note('b', 'd'))
  assert.match((await m.remember(note('c', 'd'))) ?? '', /memory is full \(2 notes\)/)
  assert.equal(await m.remember(note('a', 'updated')), undefined, '满了也能更新已有的')
})

test('forget：删掉返回 true；不存在或名字不合法返回 false，不会删到目录外', async () => {
  const dir = await tmp(); const m = file(join(dir, 'mem'))
  await writeFile(join(dir, 'victim.md'), 'x'); await m.remember(note('a', 'd'))
  assert.equal(await m.forget('a'), true); assert.equal(await m.forget('a'), false)
  assert.equal(await m.forget('../victim'), false); assert.equal(await m.forget('/etc/passwd'), false)
  assert.equal(await readFile(join(dir, 'victim.md'), 'utf8'), 'x')
})

test('手写的笔记也能用：没有 frontmatter 时描述取第一行，更新时间取文件时间；坏文件名、非 .md 被忽略；目录不存在等于空', async () => {
  const dir = await tmp()
  assert.deepEqual(await file(join(dir, 'nope')).list(), [])
  await writeFile(join(dir, 'hand-written.md'), '\n  Deploy happens on Fridays\nand never on holidays\n')
  await writeFile(join(dir, 'Not Valid.md'), 'x'); await writeFile(join(dir, 'readme.txt'), 'x'); await mkdir(join(dir, 'sub.md'))
  await utimes(join(dir, 'hand-written.md'), new Date('2026-05-05T00:00:00Z'), new Date('2026-05-05T00:00:00Z'))
  const all = await file(dir).list()
  assert.deepEqual(all.map(x => [x.name, x.description, x.updated.slice(0, 10)]), [['hand-written', 'Deploy happens on Fridays', '2026-05-05']])
  assert.match(all[0]!.content, /never on holidays/)
})

test('list：新的在前', async () => {
  const dir = await tmp(); const m = file(dir, { now: tick })
  for (const n of ['a', 'b', 'c']) await m.remember(note(n, 'd'))
  assert.deepEqual((await m.list()).map(x => x.name), ['c', 'b', 'a'])
})

// ═════════ Capability：提示里的索引和三个工具 ═════════

test('instructions：规则 + 笔记索引（一条一行，新的在前）；超过 indexItems 的提示还有多少条；没有笔记时说没有', async () => {
  const dir = await tmp(); const m = file(dir, { now: tick, indexItems: 2 })
  assert.match((await m.instructions!(ctx))!, /No notes saved yet\./)
  for (const n of ['a', 'b', 'c']) await m.remember(note(n, `about ${n}`))
  const t = (await m.instructions!(ctx))!
  assert.ok(t.includes('- c: about c\n- b: about b') && !t.includes('- a:'))
  assert.match(t, /1 older notes not listed/); assert.match(t, /not instructions/); assert.match(t, /Do not save.*secrets/)
})

test('三个工具：remember / recall / forget，错误和成功都是文本；effects 分别是 idempotent / none / idempotent', async () => {
  const m = file(await tmp(), { now: tick })
  const [rem, rec, forget] = [await toolOf(m, 'remember'), await toolOf(m, 'recall'), await toolOf(m, 'forget')]
  assert.deepEqual([rem.effects, rec.effects, forget.effects], ['idempotent', 'none', 'idempotent'])
  assert.deepEqual(await call(rem, note('lang', '回答语言', '用户希望用中文回答，代码注释也用中文。')), { text: 'Saved "lang".', isError: false })
  const bad = await call(rem, note('lang', 'd', 'password: hunter2hunter2')); assert.equal(bad.isError, true); assert.match(bad.text, /^Not saved: this looks like it contains a secret/)
  const hit = await call(rec, { query: '中文' }); assert.match(hit.text, /^## lang \(updated 2026-11-10\)\n回答语言\n\n用户希望用中文回答/)
  assert.deepEqual(await call(rec, { query: 'kubernetes' }), { text: 'No matching memories.', isError: false })
  assert.deepEqual(await call(forget, { name: 'lang' }), { text: 'Forgot "lang".', isError: false })
  assert.deepEqual(await call(forget, { name: 'lang' }), { text: 'No memory named "lang".', isError: true })
  assert.throws(() => rem.parse!({ name: 1 }), /strings/); assert.throws(() => rec.parse!({ query: ' ' }), /non-empty/); assert.throws(() => forget.parse!({}), /non-empty/)
})

test('recall：limit 默认 5、最多 20；很长的笔记在结果里截断', async () => {
  const m = file(await tmp(), { now: tick, maxChars: 10_000 }); const rec = await toolOf(m, 'recall')
  for (let i = 0; i < 8; i++) await m.remember(note(`n${i}`, 'topic', 'word'))
  assert.equal((await call(rec, { query: 'topic' })).text.split('## ').length - 1, 5)
  assert.equal((await call(rec, { query: 'topic', limit: 100 })).text.split('## ').length - 1, 8)
  for (let i = 8; i < 25; i++) await m.remember(note(`n${i}`, 'topic', 'word'))
  assert.equal((await call(rec, { query: 'topic', limit: 100 })).text.split('## ').length - 1, 20, '上限 20')
  await m.remember(note('long', 'long note', 'z'.repeat(5000)))
  assert.match((await call(rec, { query: 'long note', limit: 1 })).text, /… \[3000 more chars\]/)
})

// ═════════ 跨会话（真 core loop）═════════

test('跨会话：第一个会话里模型 remember，第二个全新的会话（新 state、新 loop）的提示里就有索引，模型 recall 拿回正文', async () => {
  const dir = await tmp()
  const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 1, outputTokens: 1 } })
  const scripted = (steps: ModelChunk[][]): ModelPort & { requests: ModelRequest[] } => {
    let i = 0; const requests: ModelRequest[] = []
    return { specVersion: 'hue.model.v1', id: 'mock', requests, info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
      async *stream(req) { requests.push(structuredClone(req)); for (const c of steps[i++] ?? []) yield c } }
  }
  const play = async (sessionId: string, model: ModelPort) => {
    const g = runTurn({ sessionId, state: emptyState(sessionId), input: userText('hi'), model, capabilities: [file(dir, { now: tick })] })
    const events: HueEvent[] = []; for (let n = await g.next(); !n.done; n = await g.next()) events.push(n.value); return events
  }
  const one = scripted([[{ type: 'tool-call', callId: 'c1', name: 'remember', input: note('reply-language', 'User wants answers in Chinese', 'Always answer in Chinese.') }, fin('tool-calls')], [{ type: 'text-delta', text: '记住了' }, fin('stop')]])
  const e1 = await play('session-1', one)
  assert.match(one.requests[0]!.instructions, /No notes saved yet/)
  assert.equal(fold('session-1', e1).transcript.length, 4)

  const two = scripted([[{ type: 'tool-call', callId: 'c2', name: 'recall', input: { query: 'language' } }, fin('tool-calls')], [{ type: 'text-delta', text: '好' }, fin('stop')]])
  await play('session-2', two)
  assert.match(two.requests[0]!.instructions, /- reply-language: User wants answers in Chinese/)
  assert.match(JSON.stringify(two.requests[1]!.messages.at(-1)), /Always answer in Chinese\./)
  assert.ok(!two.requests[0]!.instructions.includes('Always answer in Chinese.'), '索引里只有描述，正文要 recall')
})
