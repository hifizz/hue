import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HueEvent } from '@hue/core'
import { sqliteStore } from '@hue/store'
import { formatTimeline, readAll } from './replay.js'

const use = { inputTokens: 2, outputTokens: 60, cacheReadTokens: 900, cacheWriteTokens: 98 }
let seq = 0
const e = (at: number, extra: object): HueEvent => ({ v: 1, id: `e${++seq}`, sessionId: 's', seq, at, turnId: 'turn-0001-xyz', ...extra }) as HueEvent

const session = (): HueEvent[] => { seq = 0; return [
  e(1000, { type: 'turn.started' }),
  e(1000, { type: 'user.message', message: { role: 'user', content: [{ type: 'text', text: '修好 add' }] } }),
  e(1000, { type: 'step.started', step: 1 }),
  e(4000, { type: 'model.message', message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'c1', name: 'bash', input: {} }] }, modelId: 'm', finishReason: 'tool-calls', usage: use, durationMs: 3000, step: 1 }),
  e(4000, { type: 'tool.call', callId: 'c1', name: 'bash', input: { command: 'node test.js' }, effects: 'unsafe' }),
  e(4000, { type: 'policy.decided', callId: 'c1', decision: { action: 'ask', prompt: 'p' } }),
  e(4000, { type: 'input.requested', requestId: 'r1', callId: 'c1', request: { kind: 'approval', prompt: 'p' } }),
  e(9000, { type: 'input.resolved', requestId: 'r1', response: { action: 'decline', reason: 'no' } }),
  e(9000, { type: 'tool.result', callId: 'c1', name: 'bash', content: [{ type: 'text', text: 'denied by user' }], isError: true, durationMs: 0, synthetic: 'denied' }),
  e(11000, { type: 'turn.ended', turnId: 'turn-0001-xyz', reason: 'stop', usage: use, steps: 1 }),
] }

test('时间线：每步耗时和 token、审批等待、被拒绝的调用、合计都在', () => {
  const out = formatTimeline(session())
  assert.match(out, /\+0\.0s\s+── turn turn-000 开始/)
  assert.match(out, /\+3\.0s\s+模型 3\.0s\s+in 2 out 60 cacheRead 900 cacheWrite 98\s+tool-calls\s+→ 调用 bash/)
  assert.match(out, /▶ bash \[unsafe\] \{"command":"node test\.js"\}/)
  assert.match(out, /询问 → decline（等了 5\.0s）/)
  assert.match(out, /✗ bash 0\.0s \(denied\)\s+denied by user/)
  assert.match(out, /合计 10\.0s：模型 3\.0s，工具 0\.0s，等你批准 5\.0s；1 次工具调用，1 个失败，1 次被拒；缓存命中 90%/)
})

test('空会话、没有审批的会话不崩', () => {
  assert.equal(formatTimeline([]), '(空会话)')
  seq = 0
  const out = formatTimeline([e(0, { type: 'turn.started' }), e(500, { type: 'turn.ended', turnId: 't', reason: 'error', usage: { inputTokens: 0, outputTokens: 0 }, steps: 0, error: { code: 'model_error', message: 'boom' } })])
  assert.match(out, /错误 model_error: boom/); assert.match(out, /缓存命中 0%/)
})

test('从真实 sqlite 日志读回来再格式化', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'hue-replay-')), 'hue.db')
  const s = sqliteStore(db); await s.append(session()); s.close()
  const events = await readAll(db, 's')
  assert.equal(events.length, 10); assert.equal(formatTimeline(events), formatTimeline(session()))
})
