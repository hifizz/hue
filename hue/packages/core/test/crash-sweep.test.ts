/**
 * 写前日志的可复现证据。故事与解读见 docs/application/portfolio-story.md。
 *
 * 要回答的问题：一个会对外部世界产生副作用的 agent，在任意时刻被杀掉，重启后能不能知道"哪些事可能已经发生"？
 * 做法：用一个真实记录副作用的"外部世界"（world），在每个事件之后杀进程，检查日志与世界是否矛盾。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTurn, emptyState, fold, userText, isDurable, textResult, repairDangling, HUE_EVENT_VERSION } from '../src/index.js'
import type { EventInit, HueEvent, ModelChunk, ModelPort, ModelRequest, Tool } from '../src/index.js'

const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 1, outputTokens: 1 } })

/** 第 1 步并行请求两个工具（先发邮件，再读文件），第 2 步收尾。 */
function scriptedModel(seen: ModelRequest[] = []): ModelPort {
  let i = 0
  const steps: ModelChunk[][] = [
    [{ type: 'tool-call', callId: 'c1', name: 'send_email', input: { to: 'a@x.com' } }, { type: 'tool-call', callId: 'c2', name: 'read', input: {} }, fin('tool-calls')],
    [{ type: 'text-delta', text: 'done' }, fin('stop')],
  ]
  return {
    specVersion: 'hue.model.v1', id: 'mock:1',
    info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(req) { seen.push(structuredClone(req)); yield* steps[i++] ?? [] },
  }
}

/** world 是"外部世界"：它不在事件日志里，进程被杀也不会回滚。hang=true 时邮件发出后工具卡住，模拟"执行到一半被杀"。 */
function makeTools(world: string[], opts: { hang?: boolean } = {}): Tool[] {
  return [
    {
      name: 'send_email', description: 'send an email to someone', inputSchema: { type: 'object' }, effects: 'unsafe',
      async execute(_i, ctx) {
        world.push('EMAIL')
        if (opts.hang) await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
        return textResult('sent')
      },
    },
    { name: 'read', description: 'read a file from disk', inputSchema: { type: 'object' }, effects: 'none', async execute() { return textResult('contents') } },
  ]
}

/** repairDangling 返回的是没有信封的 EventInit，由调用方补齐才能落盘。 */
const seal = (sessionId: string, lastSeq: number, inits: EventInit[]): HueEvent[] =>
  inits.map((init, i) => ({ ...init, v: HUE_EVENT_VERSION, id: `repair-${i}`, sessionId, seq: lastSeq + i + 1, at: 0 }) as HueEvent)

test('在每一个事件之后杀进程：只要邮件发出过，日志里一定已有对应的 tool.call', async () => {
  const total: HueEvent[] = []
  {
    const t = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('go'), model: scriptedModel(), tools: makeTools([]) })
    for (;;) { const n = await t.next(); if (n.done) break; total.push(n.value) }
  }
  assert.equal(total.length, 12, '这个脚本固定产生 12 个事件，下面按它逐个杀')

  // 两种杀法。真实的 kill -9 可以发生在任何时刻，包括「loop 刚吐出事件、消费者还没写完磁盘」这一瞬间：
  //   afterPersist  ：事件已落盘，进程在拉下一个事件之前被杀
  //   beforePersist ：事件已到消费者手里，但磁盘写入之前进程被杀（这一种才能检验写前日志的顺序）
  for (const mode of ['afterPersist', 'beforePersist'] as const) for (let killAt = 1; killAt <= total.length; killAt++) {
    const killAfter = `${mode}@${killAt}`
    const world: string[] = []
    const log: HueEvent[] = [] // 「磁盘」
    const t = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('go'), model: scriptedModel(), tools: makeTools(world) })
    let seen = 0
    for (;;) {
      const n = await t.next(); if (n.done) break
      const isKillPoint = ++seen === killAt
      if (isKillPoint && mode === 'beforePersist') break // 事件没写进磁盘就死了
      if (isDurable(n.value)) log.push(n.value) // 先落盘，才会拉下一个
      if (isKillPoint) break // kill：不再拉 generator
    }
    await new Promise(r => setTimeout(r, 5)) // 给已发起的异步工具一点时间：它们在真实世界里可能已经跑完

    // 重启：只有日志
    const state = fold('s', log)
    if (world.includes('EMAIL')) assert.ok(log.some(e => e.type === 'tool.call' && e.callId === 'c1'), `${killAfter}: 邮件已发出，但日志里没有 tool.call`)

    // 修复后，历史对 provider 来说必须是合法的：没有悬空调用，没有未结束的 turn
    const fixed = fold('s', [...log, ...seal('s', state.lastSeq, repairDangling(state))])
    assert.equal(fixed.danglingCalls.length, 0, killAfter)
    assert.equal(fixed.openTurnId, undefined, killAfter)
  }
})

test('执行到一半被杀：邮件已发出但结果没落盘 → 恢复后标为「结果未知」，且不会再发一次', async () => {
  const world: string[] = []
  const log: HueEvent[] = []
  const ac = new AbortController()
  const t = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('go'), model: scriptedModel(), tools: makeTools(world, { hang: true }), signal: ac.signal })

  // 拉到 tool.call(c1) 并落盘
  for (;;) {
    const n = await t.next(); assert.ok(!n.done)
    if (isDurable(n.value)) log.push(n.value)
    if (n.value.type === 'tool.call' && n.value.callId === 'c1') break
  }
  // 再拉一次：这让 loop 开始执行工具。邮件发出后工具卡住，我们不再等它——这就是 kill -9。
  const inFlight = t.next()
  for (let i = 0; i < 100 && world.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(world, ['EMAIL'], '邮件已经在外部世界里发出')
  assert.ok(!log.some(e => e.type === 'tool.result'), '但日志里还没有结果')

  // ——— 重启：只有日志 ———
  const state = fold('s', log)
  assert.deepEqual(state.danglingCalls.map(d => [d.callId, d.effects]), [['c1', 'unsafe'], ['c2', 'unknown']])
  const repair = seal('s', state.lastSeq, repairDangling(state))
  const c1 = repair.find(e => e.type === 'tool.result' && e.callId === 'c1')
  assert.ok(c1 && c1.type === 'tool.result')
  assert.equal(c1.synthetic, 'crashed')
  assert.match(JSON.stringify(c1.content), /outcome is unknown/)

  // 接着跑下一个 turn：模型会看到「结果未知」，工具不会被重新执行
  const seenByModel: ModelRequest[] = []
  const resumeModel: ModelPort = { ...scriptedModel(), async *stream(req) { seenByModel.push(structuredClone(req)); yield { type: 'text-delta', text: 'ok' }; yield fin('stop') } }
  const resumed = fold('s', [...log, ...repair])
  const t2 = runTurn({ sessionId: 's', state: resumed, input: userText('did the email go out?'), model: resumeModel, tools: makeTools(world) })
  for (;;) { const n = await t2.next(); if (n.done) break }
  assert.deepEqual(world, ['EMAIL'], '恢复后没有重发邮件')
  assert.match(JSON.stringify(seenByModel[0]!.messages), /outcome is unknown/)

  ac.abort() // 清理那个卡住的工具
  await inFlight.catch(() => {})
})

test('存储写失败 ⇒ 工具不会执行（消费者不再拉取，loop 就不往前走）', async () => {
  const world: string[] = []
  const log: HueEvent[] = []
  const t = runTurn({ sessionId: 's', state: emptyState('s'), input: userText('go'), model: scriptedModel(), tools: makeTools(world) })
  const append = async (e: HueEvent) => { if (e.type === 'tool.call') throw new Error('disk full'); log.push(e) }

  let failure: unknown
  for (;;) {
    const n = await t.next(); if (n.done) break
    if (!isDurable(n.value)) continue
    try { await append(n.value) } catch (e) { failure = e; await t.return(undefined as never); break }
  }
  assert.match(String(failure), /disk full/)
  assert.deepEqual(world, [], '日志写不进去，邮件就没有发')
  assert.ok(!log.some(e => e.type === 'tool.call'))
})
