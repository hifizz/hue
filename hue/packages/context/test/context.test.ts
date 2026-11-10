import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyState, fold, isDurable, modelView, runTurn, textResult, toolCallsOf, userText } from '@hue/core'
import type { Compaction, ContextInput, ConversationState, HueEvent, Message, ModelChunk, ModelPort, ModelRequest, Tool } from '@hue/core'
import { chain, fixedTokens, foldToolResults, messageTokens, messagesTokens, summarize, SUMMARY_PROMPT, textTokens, truncate, TRUNCATED_NOTE } from '../src/index.js'
import { strategy } from '../src/engine.js'

// ═════════ 构造数据的小工具 ═════════
// 估算：ASCII 每字符 0.3 个 token。窗口 1000 → 默认触发线 800、目标 400。

const asst = (text: string, callId?: string): Message => ({
  role: 'assistant',
  content: [...(text ? [{ type: 'text' as const, text }] : []), ...(callId ? [{ type: 'tool-call' as const, callId, name: 'read', input: { path: 'f' } }] : [])],
})
const result = (callId: string, text: string, isError = false): Message =>
  ({ role: 'tool', content: [{ type: 'tool-result', callId, name: 'read', isError, content: [{ type: 'text', text }] }] })
/** 一轮：用户提问 → 助手调用工具 → 结果 → 助手回答。 */
const turn = (i: number, chars: number, isError = false): Message[] =>
  [userText(`q${i}`), asst('', `c${i}`), result(`c${i}`, `r${i}:`.padEnd(chars, 'x'), isError), asst(`done ${i}`)]
const turns = (n: number, chars: number, from = 0) => Array.from({ length: n }, (_, k) => turn(from + k, chars)).flat()

const stateOf = (transcript: Message[], compaction?: Compaction): ConversationState => ({ ...emptyState('s'), transcript, compaction })
const info = (contextWindow = 1000) => ({ contextWindow, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } })
const input = (state: ConversationState, over: Partial<ContextInput> = {}): ContextInput =>
  ({ state, instructions: '', tools: [], model: { id: 'm', info: info() }, overflowed: false, signal: new AbortController().signal, ...over })
const withCompaction = (s: ConversationState, c: Compaction | undefined) => (c ? { ...s, compaction: c } : s)
const textOf = (m: Message) => (m.role === 'user' ? m.content.map(p => (p.type === 'text' ? p.text : '')).join('') : '')
const resultText = (m: Message) => (m.role === 'tool' ? m.content.map(r => r.content.map(c => (c.type === 'text' ? c.text : '')).join('')).join('') : '')

/** 每个 tool-call 紧跟的 tool 消息里都有它的结果，tool 消息前面一定是 assistant。provider 就是用这条规则拒绝请求的。 */
function assertPaired(ms: readonly Message[]) {
  ms.forEach((m, i) => {
    if (m.role === 'tool') assert.equal(ms[i - 1]?.role, 'assistant', `tool message ${i} must follow an assistant message`)
    if (m.role !== 'assistant') return
    const ids = toolCallsOf(m).map(c => c.callId)
    if (!ids.length) return
    const next = ms[i + 1]
    assert.equal(next?.role, 'tool', `tool-call at ${i} has no result message`)
    assert.deepEqual(next!.role === 'tool' ? next!.content.map(r => r.callId).sort() : [], [...ids].sort())
  })
}

// ═════════ 估算 ═════════

test('估算：英文按字符 0.3、非 ASCII 按 1，偏高；消息有固定开销；工具结果和推理签名都算', () => {
  assert.equal(textTokens('a'.repeat(100)), 30); assert.equal(textTokens('你好世界'), 4); assert.equal(textTokens(''), 0)
  assert.ok(messageTokens(userText('hi')) > textTokens('hi'))
  const withSig = messageTokens({ role: 'assistant', content: [{ type: 'reasoning', text: '', providerMetadata: { anthropic: { signature: 'S'.repeat(400) } } }] })
  assert.ok(withSig > 100, String(withSig))
  assert.ok(messagesTokens(turn(0, 3000)) > 900)
})

// ═════════ 触发条件 ═════════

test('预算内：不压缩，视图就是 modelView，并给出估算', async () => {
  const s = stateOf(turns(2, 100))
  const out = await truncate().prepare(input(s))
  assert.equal(out.compaction, undefined); assert.deepEqual(out.messages, modelView(s)); assert.ok(out.estimatedTokens! > 0)
})

test('超过预算才压；预算默认是窗口的 80%，可以显式指定', async () => {
  const s = stateOf(turns(6, 800)) // ≈ 1600 token
  assert.ok((await truncate().prepare(input(s))).compaction)
  assert.equal((await truncate().prepare(input(s, { model: { id: 'm', info: info(10_000) } }))).compaction, undefined) // 窗口大了就不用压
  assert.ok((await truncate({ budget: 500 }).prepare(input(stateOf(turns(3, 800)), { model: { id: 'm', info: info(10_000) } }))).compaction)
})

test('超窗重试（overflowed）：即使估算在预算内也要压，并且至少压掉 40%——因为这时我们的估算是错的', async () => {
  const s = stateOf(turns(3, 600)) // ≈ 600 token，预算内
  const out = await truncate().prepare(input(s, { overflowed: true }))
  assert.ok(out.compaction, 'must compact')
  assert.ok(out.compaction!.tokensAfter <= out.compaction!.tokensBefore * 0.6 + 60, `${out.compaction!.tokensBefore} → ${out.compaction!.tokensAfter}`)
})

// ═════════ truncate ═════════

test('truncate：压到目标以下；第一条是说明，后面是原样的最近几轮；调用和结果不被拆开；Compaction 可 JSON 序列化', async () => {
  const t = turns(6, 800)
  const s = stateOf(t)
  const out = await truncate().prepare(input(s))
  const c = out.compaction!
  assert.equal(c.strategy, 'truncate'); assert.ok(c.tokensAfter < c.tokensBefore); assert.ok(c.tokensAfter <= 400, String(c.tokensAfter))
  assert.ok(textOf(out.messages[0]!).trim().endsWith(TRUNCATED_NOTE))
  assert.deepEqual(out.messages.slice(1), t.slice(c.throughIndex)) // 保留的部分一个字都没动
  assert.ok(['user', 'assistant'].includes(out.messages[1]!.role)) // 切在轮边界，或切在某个工具结果之后
  assertPaired(out.messages)
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c)
})

test('truncate：压缩后的下一步在预算内，不会再压；之后继续增长再压，说明不会叠加，throughIndex 单调往后', async () => {
  const t = turns(6, 800)
  const first = (await truncate().prepare(input(stateOf(t)))).compaction!
  const s1 = stateOf(t, first)
  const again = await truncate().prepare(input(s1))
  assert.equal(again.compaction, undefined); assert.deepEqual(again.messages, modelView(s1))

  const t2 = [...t, ...turns(4, 800, 6)]
  const second = await truncate().prepare(input(stateOf(t2, first)))
  assert.ok(second.compaction); assert.ok(second.compaction!.throughIndex > first.throughIndex)
  assert.equal(second.compaction!.replacement.length, 1); assert.equal(textOf(second.compaction!.replacement[0]!).split(TRUNCATED_NOTE).length, 2) // 只有一条说明，没有叠加
  assert.deepEqual(second.messages.slice(1), t2.slice(second.compaction!.throughIndex))
})

test('truncate：keepTurns 指定的最近几轮一定保留', async () => {
  const t = turns(6, 800)
  const out = await truncate({ keepTurns: 3 }).prepare(input(stateOf(t)))
  assert.deepEqual(out.messages.slice(1), t.slice(-12)) // 最近 3 轮 = 12 条
})

test('truncate：只有一轮（没法切）时不压缩，视图原样返回——超了也交给 provider 报错', async () => {
  const s = stateOf(turn(0, 5000))
  const out = await truncate().prepare(input(s))
  assert.equal(out.compaction, undefined); assert.deepEqual(out.messages, modelView(s))
})

test('固定开销（系统提示 + 工具说明）计入预算', async () => {
  const s = stateOf(turns(3, 600)) // 视图 ≈ 600，单看在预算内
  assert.equal((await truncate().prepare(input(s))).compaction, undefined)
  const big = await truncate().prepare(input(s, { instructions: 'S'.repeat(1000) })) // +300
  assert.ok(big.compaction)
})

// ═════════ foldToolResults ═════════

const resultsOf = (ms: Message[]) => ms.filter(m => m.role === 'tool').map(resultText)
const isFolded = (t: string) => t.startsWith('[Output of read omitted')

test('foldToolResults：从最早的开始折叠旧结果，最近 keepRecent 条原样；调用、isError、工具名都在', async () => {
  const t = [...turn(0, 2000, true), ...turns(4, 2000, 1)]
  const out = await foldToolResults({ keepRecent: 4 }).prepare(input(stateOf(t)))
  const c = out.compaction!
  assert.equal(c.strategy, 'fold-tool-results'); assert.ok(c.tokensAfter < c.tokensBefore)
  assert.deepEqual(out.messages.slice(-4), t.slice(-4)) // 最近 4 条（最后一轮）没动
  const rs = resultsOf(out.messages)
  assert.deepEqual(rs.map(isFolded), [true, true, true, true, false])
  assert.match(rs[1]!, /\[Output of read omitted to save context \(2000 chars\)\. Run the tool again/)
  const firstTool = out.messages.find(m => m.role === 'tool')!
  assert.equal(firstTool.role === 'tool' && firstTool.content[0]!.isError, true) // 错误标记保留
  assert.equal(out.messages.length, t.length) // 消息一条没少，骨架还在
  assert.deepEqual(out.messages.filter(m => m.role !== 'tool'), t.filter(m => m.role !== 'tool'))
  assertPaired(out.messages)
})

test('foldToolResults：折到放得下就停，不多折；折叠后的占位符不会被再折', async () => {
  const t = turns(5, 2000) // ≈ 3000 token
  const out = await foldToolResults({ keepRecent: 4, budget: 2000, target: 1500 }).prepare(input(stateOf(t)))
  const flags = resultsOf(out.messages).map(isFolded)
  const k = flags.indexOf(false)
  assert.ok(k >= 1 && k < 4, JSON.stringify(flags)) // 折了一部分（每个约省 600），不是全部
  assert.ok(flags.slice(k).every(f => !f), 'folded results must be a prefix (oldest first)')
  assert.ok(out.compaction!.tokensAfter <= 1500)

  const all = await foldToolResults({ keepRecent: 4, budget: 1, target: 0 }).prepare(input(stateOf(t))) // 逼它把能折的全折掉
  assert.deepEqual(resultsOf(all.messages).map(isFolded), [true, true, true, true, false])
  const again = await foldToolResults({ keepRecent: 4, budget: 1, target: 0 }).prepare(input(stateOf(t, all.compaction))) // 再逼一次
  assert.equal(again.compaction, undefined) // 占位符不会被再折；没有变化就不写新的 Compaction
})

test('foldToolResults：短结果不折；没有可折的东西时不压缩', async () => {
  const small = stateOf(turns(8, 300)) // 结果 300 字符 < minChars
  assert.equal((await foldToolResults({ budget: 100 }).prepare(input(small))).compaction, undefined)
  assert.equal((await foldToolResults({ budget: 1, keepRecent: 100 }).prepare(input(stateOf(turns(2, 2000))))).compaction, undefined)
})

// ═════════ Compaction 下标换算（在已压缩的视图上再压）═════════

test('在 fold 之后再 truncate：切点落进旧 replacement 里时，throughIndex 不动、旧 replacement 没被切到的部分接在后面', async () => {
  const t = turns(5, 2000)
  const f = (await foldToolResults({ keepRecent: 4 }).prepare(input(stateOf(t)))).compaction!
  assert.ok(f.replacement.length > 8)
  const s1 = stateOf(t, f)
  const view = modelView(s1)
  const out = await truncate({ keepTurns: 3, budget: 100 }).prepare(input(s1))
  const c = out.compaction!
  assert.equal(c.throughIndex, f.throughIndex, '切点在旧 replacement 里，transcript 的切点不变')
  assert.ok(textOf(out.messages[0]!).endsWith(TRUNCATED_NOTE))
  assert.deepEqual(out.messages.slice(1), view.slice(view.length - (out.messages.length - 1))) // 新视图 = 说明 + 旧视图的一个后缀
  assert.ok(out.messages.length - 1 >= 12) // 保留了 3 轮
  assertPaired(out.messages)
  // 核心用 modelView 套这个 Compaction 得到的，和我们返回的一致
  assert.deepEqual(modelView(withCompaction(s1, c)), out.messages)
})

test('切点在旧 replacement 之后：throughIndex 往后推', async () => {
  const t = turns(10, 800)
  const first = (await truncate().prepare(input(stateOf(t.slice(0, 24))))).compaction!
  const out = await truncate().prepare(input(stateOf(t, first)))
  assert.ok(out.compaction!.throughIndex > first.throughIndex)
  assert.deepEqual(modelView(withCompaction(stateOf(t, first), out.compaction)), out.messages)
})

test('engine：切点越界直接报错，而不是悄悄生成坏数据', async () => {
  const bad = strategy('bad', {}, async () => ({ cut: 0, replacement: [userText('x')] }))
  await assert.rejects(bad.prepare(input(stateOf(turns(6, 800)))), /outside the view/)
  const noop = strategy('noop', {}, async ({ view }) => ({ cut: 2, replacement: view.slice(0, 2) }))
  assert.equal((await noop.prepare(input(stateOf(turns(6, 800))))).compaction, undefined) // 替换成一模一样的东西等于没压
})

// ═════════ summarize ═════════

function summarizer(script: Array<ModelChunk[] | Error>, window = 100_000): ModelPort & { requests: ModelRequest[] } {
  let i = 0; const requests: ModelRequest[] = []
  return {
    specVersion: 'hue.model.v1', id: 'mock:sum', info: info(window), requests,
    async *stream(req) {
      requests.push(structuredClone(req))
      const step = script[i++] ?? script.at(-1)!
      if (step instanceof Error) throw step
      yield* step
    },
  }
}
const FIN: ModelChunk = { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }
const says = (t: string): ModelChunk[] => [{ type: 'text-delta', text: t }, FIN]

test('summarize：被丢掉的部分换成摘要，最近 keepTurns 轮原文保留；摘要请求是纯文本、没有工具、限制了长度', async () => {
  const t = turns(6, 800)
  const model = summarizer([says('SUMMARY TEXT: edited calc.js')])
  const out = await summarize({ model, keepTurns: 2, summaryTokens: 100 }).prepare(input(stateOf(t)))
  const c = out.compaction!
  assert.equal(c.strategy, 'summarize')
  assert.match(textOf(out.messages[0]!), /^\[Summary of the earlier conversation.*\n\nSUMMARY TEXT: edited calc\.js$/s)
  assert.deepEqual(out.messages.slice(1), t.slice(-8)) // 最近 2 轮原文
  assertPaired(out.messages)

  const req = model.requests[0]!
  assert.equal(req.instructions, SUMMARY_PROMPT); assert.deepEqual(req.tools, []); assert.equal(req.settings?.maxOutputTokens, 100)
  assert.equal(req.messages.length, 1); assert.equal(req.messages[0]!.role, 'user')
  const body = textOf(req.messages[0]!)
  assert.ok(body.includes('q0') && body.includes('[tool call] read') && body.includes('[tool result: read]'))
  assert.ok(!body.includes('q5') && !body.includes('q4'), '保留的最近两轮不进摘要')
})

test('summarize：下一次摘要会带上上一次的摘要，旧的内容不会凭空消失', async () => {
  const t = turns(6, 800)
  const model = summarizer([says('FIRST SUMMARY'), says('SECOND SUMMARY')])
  const s = summarize({ model, keepTurns: 1, summaryTokens: 100 })
  const c1 = (await s.prepare(input(stateOf(t)))).compaction!
  const t2 = [...t, ...turns(6, 800, 6)]
  const out = await s.prepare(input(stateOf(t2, c1)))
  assert.ok(textOf(model.requests[1]!.messages[0]!).includes('FIRST SUMMARY'))
  assert.match(textOf(out.messages[0]!), /SECOND SUMMARY/)
})

test('summarize：模型报错 / 输出为空 / 抛异常 / 没有 finish → 退回 truncate，不让 agent 因压缩失败而卡死', async () => {
  const t = turns(6, 800)
  const cases: Array<[string, Array<ModelChunk[] | Error>]> = [
    ['error chunk', [[{ type: 'error', error: { code: 'model_error', message: 'boom' } }]]],
    ['empty', [[FIN]]], ['whitespace', [says('  \n')]],
    ['throws', [new Error('network')]],
    ['no finish', [[{ type: 'text-delta', text: 'cut off' }]]],
  ]
  for (const [name, script] of cases) {
    const out = await summarize({ model: summarizer(script), summaryTokens: 100 }).prepare(input(stateOf(t)))
    assert.equal(out.compaction?.strategy, 'summarize→truncate', name)
    assert.equal(textOf(out.messages[0]!), TRUNCATED_NOTE, name)
  }
})

test('summarize：被取消时不压缩（让 loop 自己处理取消），也不退回 truncate', async () => {
  const ac = new AbortController(); ac.abort()
  const model = summarizer([Object.assign(new Error('aborted'), { name: 'AbortError' })])
  const s = stateOf(turns(6, 800))
  const out = await summarize({ model }).prepare(input(s, { signal: ac.signal }))
  assert.equal(out.compaction, undefined); assert.deepEqual(out.messages, modelView(s))
})

test('summarize：要摘要的内容比摘要模型的窗口还大时，保留靠后的部分并标明前面被省略', async () => {
  const model = summarizer([says('S')], 600)
  await summarize({ model, keepTurns: 1, summaryTokens: 50 }).prepare(input(stateOf(turns(12, 800))))
  const body = textOf(model.requests[0]!.messages[0]!)
  assert.match(body, /oldest part of the conversation is not shown/)
  assert.ok(textTokens(body) <= 600, String(textTokens(body))); assert.ok(body.includes('q10') && !body.includes('q0'))
})

// ═════════ chain ═════════

test('chain：折叠就够了就不调摘要模型；compaction 只返回最后的那一个', async () => {
  const model = summarizer([says('NEVER')])
  const s = stateOf(turns(5, 2000))
  // 折完约 860 token：给摘要一个更宽的预算，它看到已经在预算内，就不会去调模型。
  const out = await chain(foldToolResults({ keepRecent: 4, budget: 1500, target: 1200 }), summarize({ model, budget: 2000 })).prepare(input(s))
  assert.equal(model.requests.length, 0); assert.equal(out.compaction!.strategy, 'fold-tool-results')
  assert.deepEqual(modelView(withCompaction(s, out.compaction)), out.messages)
})

test('chain：折叠不够再摘要；strategy 写明两步，tokensBefore 是最开始的，结果仍能被核心还原', async () => {
  // 前面三轮有可折叠的大结果，后面每轮的用户消息本身就很长：折完还是超。
  const t = [...turns(3, 2000), ...Array.from({ length: 5 }, (_, i) => [userText(`big${i}:`.padEnd(1500, 'u')), asst(`ok ${i}`)]).flat()]
  const s = stateOf(t)
  const model = summarizer([says('MERGED SUMMARY')])
  const out = await chain(foldToolResults({ keepRecent: 4 }), summarize({ model, keepTurns: 1, summaryTokens: 100 })).prepare(input(s))
  const c = out.compaction!
  assert.equal(c.strategy, 'fold-tool-results+summarize')
  assert.equal(c.tokensBefore, fixedTokens('', []) + messagesTokens(modelView(s))); // 含系统提示和工具的固定部分 assert.ok(c.tokensAfter < c.tokensBefore / 2)
  assert.equal(model.requests.length, 1)
  assert.ok(textOf(model.requests[0]!.messages[0]!).includes('omitted to save context'), '摘要看到的是折叠后的视图')
  assert.match(textOf(out.messages[0]!), /MERGED SUMMARY/)
  assert.deepEqual(modelView(withCompaction(s, c)), out.messages)
})

test('chain：超窗重试时，前一个已经压过，后一个不会再无条件压一次', async () => {
  const model = summarizer([says('NEVER')])
  const s = stateOf(turns(3, 1500)) // 预算内，但可折叠
  const out = await chain(foldToolResults({ keepRecent: 4 }), summarize({ model })).prepare(input(s, { overflowed: true }))
  assert.equal(out.compaction!.strategy, 'fold-tool-results'); assert.equal(model.requests.length, 0)
})

test('chain：谁都不需要压时原样返回', async () => {
  const s = stateOf(turns(2, 100))
  const out = await chain(foldToolResults(), truncate()).prepare(input(s))
  assert.equal(out.compaction, undefined); assert.deepEqual(out.messages, modelView(s))
})

// ═════════ 长任务：只有一条用户消息，切在工具结果之后 ═════════

const TASK = 'FIX THE BUG in calc.js and make the tests pass'
/** 一条用户消息 + n 步（assistant 调用工具 → 结果）。停在最后一个结果上，下一步就要调模型。 */
const longTask = (n: number, chars = 800): Message[] =>
  [userText(TASK), ...Array.from({ length: n }, (_, i) => [asst(`step ${i}`, `c${i}`), result(`c${i}`, `r${i}:`.padEnd(chars, 'x'))]).flat()]
const assistants = (ms: readonly Message[]) => ms.filter(m => m.role === 'assistant').length

test('长任务里 truncate 也能切：任务原文带过去，保留下来的从 assistant 开始，调用和结果不被拆开，至少剩 keepSteps 步', async () => {
  const t = longTask(14) // ≈ 3400 token，窗口 1000
  const out = await truncate().prepare(input(stateOf(t)))
  const c = out.compaction!
  assert.ok(c, '一条用户消息的长任务以前无处可切'); assert.ok(c.tokensAfter < c.tokensBefore)
  assert.equal(out.messages[0]!.role, 'user')
  assert.ok(textOf(out.messages[0]!).startsWith(TASK) && textOf(out.messages[0]!).endsWith(TRUNCATED_NOTE), textOf(out.messages[0]!))
  assert.equal(out.messages[1]!.role, 'assistant'); assert.deepEqual(out.messages.slice(1), t.slice(c.throughIndex))
  assert.ok(assistants(out.messages) >= 6, `${assistants(out.messages)} steps kept`)
  assertPaired(out.messages); assert.deepEqual(modelView(withCompaction(stateOf(t), c)), out.messages)
})

test('keepSteps：切完至少剩这么多步；总共不够就不切', async () => {
  const t = longTask(14)
  const out = await truncate({ keepSteps: 10 }).prepare(input(stateOf(t)))
  assert.equal(assistants(out.messages), 10)
  const few = stateOf(longTask(4, 2000)) // 超了，但总共才 4 步 < 6
  const none = await truncate().prepare(input(few))
  assert.equal(none.compaction, undefined); assert.deepEqual(none.messages, modelView(few))
})

test('带过去的任务原文也算在预算里：任务很长时，切点要选得更靠后，压完仍在目标之内', async () => {
  const t = [userText(`${TASK}: `.padEnd(900, 'k')), ...longTask(14).slice(1)] // 任务本身 ≈ 270 token
  const out = await truncate({ keepSteps: 1 }).prepare(input(stateOf(t), { model: { id: 'm', info: info(2000) } }))
  assert.ok(out.compaction!.tokensAfter <= 800, String(out.compaction!.tokensAfter)) // 目标 = 窗口 80% 的一半
  assert.ok(textOf(out.messages[0]!).startsWith(TASK))
})

test('长任务里 summarize：摘要里有被丢掉的步骤，任务原文原样保留在摘要前面', async () => {
  const t = longTask(14)
  const model = summarizer([says('Read r0..r7, nothing fixed yet.')])
  const out = await summarize({ model, summaryTokens: 100 }).prepare(input(stateOf(t)))
  const c = out.compaction!
  assert.equal(c.strategy, 'summarize'); assert.equal(out.messages[1]!.role, 'assistant')
  assert.ok(textOf(out.messages[0]!).startsWith(TASK) && /Read r0\.\.r7/.test(textOf(out.messages[0]!)))
  const body = textOf(model.requests[0]!.messages[0]!)
  assert.ok(body.includes(TASK) && body.includes('[tool result: read]') && body.includes('step 0'))
  assert.ok(!body.includes(`step ${13}`), '保留的最近几步不进摘要')
  assert.ok(assistants(out.messages) >= 6); assertPaired(out.messages)
  assert.deepEqual(modelView(withCompaction(stateOf(t), c)), out.messages)
})

test('长任务压第二次：任务原文只出现一次，说明不叠加，throughIndex 往后推，核心还原的和策略返回的一致', async () => {
  const t = longTask(14)
  const first = (await truncate().prepare(input(stateOf(t)))).compaction!
  const t2 = [...t, ...longTask(14).slice(1).map(m => structuredClone(m))] // 又干了 14 步
  const out = await truncate().prepare(input(stateOf(t2, first)))
  const c = out.compaction!
  assert.ok(c && c.throughIndex > first.throughIndex)
  const head = textOf(out.messages[0]!)
  assert.equal(head.split(TASK).length, 2, 'task once'); assert.equal(head.split(TRUNCATED_NOTE).length, 2, 'one note')
  assertPaired(out.messages); assert.deepEqual(modelView(withCompaction(stateOf(t2, first), c)), out.messages)
})

test('长任务里有 steer 插话：最近一条用户消息（插话）作为任务带过去', async () => {
  const t = [...longTask(8), userText('also update the README'), ...longTask(8).slice(1)]
  const out = await truncate({ budget: 600 }).prepare(input(stateOf(t)))
  const head = textOf(out.messages[0]!)
  assert.ok(out.compaction && out.messages[1]!.role !== 'tool')
  // 切点在插话之前就带原任务，在插话之后就带插话；两种情况开头都得有一条真实的用户指令
  assert.ok(head.startsWith(TASK) || head.startsWith('also update the README'), head)
  assertPaired(out.messages)
})

test('任意预算下，truncate / summarize 的结果都满足 provider 的结构要求', async () => {
  const models = [longTask(20), turns(6, 600), [...longTask(6), ...turns(2, 600), ...longTask(9)]]
  for (const t of models) for (const budget of Array.from({ length: 38 }, (_, i) => 100 + i * 40)) for (const keepTurns of [1, 2]) for (const keepSteps of [1, 6]) {
    for (const s of [truncate({ budget, keepTurns, keepSteps }), summarize({ model: summarizer([says('S')]), budget, keepTurns, keepSteps, summaryTokens: 20 })]) {
      const state = stateOf(t); const out = await s.prepare(input(state))
      const ctx = `${s.name} budget=${budget} keepTurns=${keepTurns} keepSteps=${keepSteps} len=${t.length}`
      assertPaired(out.messages)
      assert.notEqual(out.messages[0]!.role, 'tool', ctx); assert.notEqual(out.messages[0]!.role, 'assistant', ctx)
      if (out.compaction) {
        assert.ok(['user', 'assistant'].includes(out.messages[1]!.role), ctx)
        assert.deepEqual(modelView(withCompaction(state, out.compaction)), out.messages, ctx)
      }
    }
  }
})

// ═════════ 和真 core 的 runTurn 配合 ═════════

const big: Tool = { name: 'big', description: 'returns a lot of text', inputSchema: { type: 'object' }, effects: 'none', async execute() { return textResult('y'.repeat(3000)) } }
const usage = { inputTokens: 1, outputTokens: 1 }
async function run(g: ReturnType<typeof runTurn>) {
  const events: HueEvent[] = []
  while (true) { const n = await g.next(); if (n.done) return { events, result: n.value }; events.push(n.value) }
}

test('集成（真 core loop）：长任务不断读大文件，窗口始终够用；压缩事件落进日志，fold(日志) 等于 turn 的 state', async () => {
  const requests: Message[][] = []; let n = 0
  const model: ModelPort = {
    specVersion: 'hue.model.v1', id: 'mock:1', info: info(3000),
    async *stream(req) {
      requests.push(structuredClone(req.messages)); n++
      yield n <= 7 ? { type: 'tool-call', callId: `c${n}`, name: 'big', input: {} } : { type: 'text-delta', text: 'finished' }
      yield { type: 'finish', finishReason: n <= 7 ? 'tool-calls' : 'stop', usage }
    },
  }
  const { events, result: r } = await run(runTurn({
    sessionId: 's', state: emptyState('s'), input: userText('go'), model, tools: [big], maxSteps: 20,
    context: chain(foldToolResults({ keepRecent: 2 }), truncate()),
  }))
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 8)
  assert.ok(events.some(e => e.type === 'context.compacted'))
  for (const [i, ms] of requests.entries()) { assertPaired(ms); assert.ok(messagesTokens(ms) <= 3000, `request ${i + 1}: ${messagesTokens(ms)} tokens`) }
  assert.ok(messagesTokens(requests.at(-1)!) < 3000)
  const log = events.filter(isDurable)
  const json = (x: unknown) => JSON.parse(JSON.stringify(x))
  assert.deepEqual(json(fold('s', log)), json(r.state)) // 压缩进了日志，回放得到同样的 state
  assert.equal(r.state.transcript.length, 1 + 7 * 2 + 1) // transcript 从不删：用户 + 7 对（assistant 调用、tool 结果）+ 最后的回答
})

test('集成（真 core loop）：模型报超窗 → loop 带 overflowed 重来 → context 压缩 → 第二次请求成功', async () => {
  const history = turns(5, 800) // ≈ 1400 token，远在 10 万窗口的预算内
  const requests: number[] = []
  const model: ModelPort = {
    specVersion: 'hue.model.v1', id: 'mock:1', info: info(100_000),
    async *stream(req) {
      const size = messagesTokens(req.messages); requests.push(size)
      if (size > 1000) { yield { type: 'error', error: { code: 'context_overflow', message: 'prompt is too long' } }; return }
      yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', finishReason: 'stop', usage }
    },
  }
  const { events, result: r } = await run(runTurn({ sessionId: 's', state: stateOf(history), input: userText('next'), model, context: truncate() }))
  assert.equal(r.reason, 'stop')
  assert.equal(requests.length, 2); assert.ok(requests[0]! > 1000 && requests[1]! <= 1000, JSON.stringify(requests))
  assert.equal(events.filter(e => e.type === 'context.compacted').length, 1)
})

const mid: Tool = { name: 'mid', description: 'returns some text', inputSchema: { type: 'object' }, effects: 'none', async execute() { return textResult('y'.repeat(700)) } }
test('集成（真 core loop）：只有一条用户消息的长任务，只用 truncate 也能压；每次请求都带着任务原文，fold(日志) 等于 state', async () => {
  const requests: Message[][] = []; let n = 0
  const model: ModelPort = {
    specVersion: 'hue.model.v1', id: 'mock:1', info: info(2000),
    async *stream(req) {
      requests.push(structuredClone(req.messages)); n++
      yield n <= 24 ? { type: 'tool-call', callId: `c${n}`, name: 'mid', input: {} } : { type: 'text-delta', text: 'finished' }
      yield { type: 'finish', finishReason: n <= 24 ? 'tool-calls' : 'stop', usage }
    },
  }
  const { events, result: r } = await run(runTurn({ sessionId: 's', state: emptyState('s'), input: userText(TASK), model, tools: [mid], maxSteps: 40, context: truncate() }))
  assert.equal(r.reason, 'stop'); assert.equal(r.steps, 25)
  assert.ok(events.filter(e => e.type === 'context.compacted').length >= 2, 'compacted more than once')
  for (const [i, ms] of requests.entries()) {
    assertPaired(ms); assert.ok(messagesTokens(ms) <= 2000, `request ${i + 1}: ${messagesTokens(ms)} tokens`)
    assert.ok(textOf(ms[0]!).includes(TASK), `request ${i + 1} lost the task`)
  }
  const json = (x: unknown) => JSON.parse(JSON.stringify(x))
  assert.deepEqual(json(fold('s', events.filter(isDurable))), json(r.state))
})
