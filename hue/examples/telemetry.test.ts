import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message, ModelChunk, ModelPort } from '@hue/core'
import { presets } from '@hue/policy'
import { createAgent, drain, subagentTool } from '@hue/runtime'
import { local } from '@hue/sandbox'
import { sqliteStore } from '@hue/store'
import { codingTools } from '@hue/tools'
import { observeStore, telemetry } from '@hue/telemetry'
import type { Exporter, Span } from '@hue/telemetry'

const fin = (r: 'stop' | 'tool-calls', u = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 400 }): ModelChunk => ({ type: 'finish', finishReason: r, usage: u })
const call = (callId: string, name: string, input: object): ModelChunk => ({ type: 'tool-call', callId, name, input: input as never })
const info = { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } }
const scripted = (id: string, steps: ModelChunk[][]): ModelPort => { let i = 0; return { specVersion: 'hue.model.v1', id, info, async *stream(_r: { messages: Message[] }) { for (const c of steps[i++] ?? [{ type: 'text-delta', text: 'done' } as ModelChunk, fin('stop')]) yield c } } }

test('真 runtime + sqlite + 子 agent:observeStore 一次收齐父子会话,得到一棵连着的 trace', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hue-tel-')); writeFileSync(join(dir, 'a.txt'), 'hello')
  const exported: Span[] = []; const exporter: Exporter = { async export(s) { exported.push(...s) } }
  const t = telemetry({ exporter, intervalMs: 60_000 })
  const store = observeStore(sqliteStore(join(dir, 'hue.db')), t)
  const sandbox = await local({ root: dir })
  const child = createAgent({ model: scripted('anthropic:child-model', [[call('g1', 'read', { path: 'a.txt' }), fin('tool-calls')], [{ type: 'text-delta', text: 'it says hello' }, fin('stop')]]), store, tools: codingTools(), sandbox, policy: presets.yolo() })
  const parent = createAgent({ model: scripted('anthropic:parent-model', [[call('k1', 'task', { task: 'read a.txt' }), fin('tool-calls')], [{ type: 'text-delta', text: 'ok' }, fin('stop')]]), store, tools: [subagentTool({ agent: child, effects: 'none' })], policy: presets.yolo() })
  const r = await drain(parent.run('go', { sessionId: 'P' }))
  await t.shutdown()
  assert.equal(r.reason, 'stop')

  const names = exported.map(s => s.name).sort()
  assert.deepEqual(names, ['chat child-model', 'chat child-model', 'chat parent-model', 'chat parent-model', 'execute_tool read', 'execute_tool task', 'invoke_agent', 'invoke_agent'])
  assert.equal(new Set(exported.map(s => s.traceId)).size, 1, '父子在同一条 trace 里')
  const byId = new Map(exported.map(s => [s.spanId, s]))
  const roots = exported.filter(s => !s.parentSpanId || !byId.has(s.parentSpanId)); assert.equal(roots.length, 1); assert.equal(roots[0]!.attributes['gen_ai.conversation.id'], 'P')
  const childTurn = exported.find(s => s.name === 'invoke_agent' && s.attributes['gen_ai.conversation.id'] !== 'P')!
  assert.equal(byId.get(childTurn.parentSpanId!)!.attributes['gen_ai.tool.name'], 'task', '子 agent 的 turn 挂在父的 task 调用下面')
  const chat = exported.find(s => s.name === 'chat parent-model')!
  assert.equal(chat.attributes['gen_ai.usage.input_tokens'], 500, '100 + 缓存读 400'); assert.equal(chat.attributes['gen_ai.usage.cache_read.input_tokens'], 400)
})
