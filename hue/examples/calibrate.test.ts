import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HueEvent } from '@hue/core'
import { calibrate, formatCalibration } from './calibrate.js'

let seq = 0
const env = (turnId = 't1', step?: number) => ({ v: 1 as const, id: `e${++seq}`, sessionId: 's1', seq, at: 1000 + seq, turnId, ...(step !== undefined && { step }) })
const stepStarted = (step: number, estimatedTokens: number) => ({ ...env('t1', step), type: 'step.started', step, estimatedTokens }) as HueEvent
const modelMsg = (step: number, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }) =>
  ({ ...env('t1', step), type: 'model.message', message: { role: 'assistant', content: [] }, modelId: 'm', finishReason: 'stop', usage, durationMs: 5 }) as HueEvent
const toolCall = (callId: string, name: string, input: object) => ({ ...env(), type: 'tool.call', callId, name, input, effects: 'unsafe' }) as HueEvent
const policy = (callId: string, decision: object) => ({ ...env(), type: 'policy.decided', callId, decision }) as HueEvent
const toolResult = (callId: string, name: string, isError: boolean, durationMs: number, synthetic?: string) =>
  ({ ...env(), type: 'tool.result', callId, name, content: [], isError, durationMs, ...(synthetic && { synthetic }) }) as HueEvent

test('估算对真实输入：比值、低估次数和最差一步；真实输入含缓存读写', () => {
  const c = calibrate([{ id: 's1', events: [
    stepStarted(1, 1200), modelMsg(1, { inputTokens: 100, outputTokens: 5, cacheReadTokens: 800, cacheWriteTokens: 100 }), // 1200/1000 = 1.2
    stepStarted(2, 900), modelMsg(2, { inputTokens: 1000, outputTokens: 5 }), // 0.9 → 低估
    stepStarted(3, 2000), modelMsg(3, { inputTokens: 1000, outputTokens: 5 }), // 2.0
  ] }])
  assert.equal(c.estimate.n, 3); assert.equal(c.estimate.underEstimated, 1)
  assert.equal(c.estimate.ratioMin, 0.9); assert.equal(c.estimate.ratioMedian, 1.2); assert.equal(c.estimate.ratioMax, 2)
  assert.deepEqual(c.estimate.worst, { session: 's1', step: 2, estimated: 900, actual: 1000 })
  assert.match(formatCalibration(c), /低估了 1 次/)
})

test('压缩：记录前后 token，以及压缩后下一步的缓存读取', () => {
  const c = calibrate([{ id: 's1', events: [
    { ...env(), type: 'context.compacted', compaction: { strategy: 'fold-tool-results', throughIndex: 4, replacement: [], tokensBefore: 90_000, tokensAfter: 40_000 } } as HueEvent,
    stepStarted(2, 41_000), modelMsg(2, { inputTokens: 40_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 38_000 }),
  ] }])
  assert.deepEqual(c.compactions, [{ session: 's1', strategy: 'fold-tool-results', before: 90_000, after: 40_000, nextStepCacheRead: 0, nextStepInput: 78_000 }])
  assert.match(formatCalibration(c), /fold-tool-results：90000 → 40000/)
})

test('policy：按工具统计问 / 拒；列出被问的 bash 命令（去重）和被拒原因', () => {
  const c = calibrate([{ id: 's1', events: [
    toolCall('a', 'bash', { command: 'npm install' }), policy('a', { action: 'ask', prompt: 'x' }),
    toolCall('b', 'bash', { command: 'npm install' }), policy('b', { action: 'ask', prompt: 'x' }),
    toolCall('c', 'bash', { command: 'sudo rm' }), policy('c', { action: 'deny', reason: 'sudo is not allowed' }),
    toolCall('d', 'read', { path: 'a' }), policy('d', { action: 'allow' }),
  ] }])
  assert.deepEqual([c.policy.allowed, c.policy.asked, c.policy.denied], [1, 2, 1])
  assert.deepEqual(c.policy.byTool.bash, { asked: 2, denied: 1 })
  assert.deepEqual(c.policy.askedCommands, ['npm install', 'npm install'])
  const text = formatCalibration(c)
  assert.equal(text.split('npm install').length - 1, 1, '报告里去重')
  assert.match(text, /bash: sudo is not allowed/)
})

test('工具：失败按工具分布、synthetic 计数、最慢的几个按耗时降序', () => {
  const c = calibrate([{ id: 's1', events: [
    toolCall('a', 'edit', {}), toolResult('a', 'edit', true, 5),
    toolCall('b', 'bash', {}), toolResult('b', 'bash', false, 9000),
    toolCall('c', 'bash', {}), toolResult('c', 'bash', true, 100, 'interrupted'),
  ] }])
  assert.equal(c.tools.calls, 3); assert.equal(c.tools.errors, 2)
  assert.deepEqual(c.tools.errorsByTool, { edit: 1, bash: 1 }); assert.deepEqual(c.tools.synthetic, { interrupted: 1 })
  assert.deepEqual(c.tools.slowest.map(s => s.ms), [9000, 100, 5])
})

test('空日志和缺 estimatedTokens 不会崩，也不会输出 NaN / Infinity', () => {
  const none = formatCalibration(calibrate([{ id: 's1', events: [] }]))
  assert.match(none, /没有可对比的步骤/); assert.ok(!/NaN|Infinity/.test(none))
  const noEst = formatCalibration(calibrate([{ id: 's1', events: [modelMsg(1, { inputTokens: 10, outputTokens: 1 })] }]))
  assert.match(noEst, /没有可对比的步骤/); assert.ok(!/NaN|Infinity/.test(noEst))
})

test('缓存命中百分比 = 缓存读 / 全部输入', () => {
  const c = calibrate([{ id: 's1', events: [modelMsg(1, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 300, cacheWriteTokens: 100 })] }])
  assert.equal(c.usage.cacheHitPct, 60)
})
