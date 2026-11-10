import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HueEvent, Message, ModelChunk, ModelPort } from '@hue/core'
import { codingTasks, formatReport, runEval, summarize } from '@hue/eval'
import { presets } from '@hue/policy'
import { local } from '@hue/sandbox'
import { sqliteStore } from '@hue/store'
import { agentRunner } from './eval.js'

const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 5, outputTokens: 5 } })
const call = (callId: string, name: string, input: object): ModelChunk => ({ type: 'tool-call', callId, name, input: input as never })
function scripted(steps: ModelChunk[][]): ModelPort {
  let i = 0
  return { specVersion: 'hue.model.v1', id: 'mock:1', info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(_req: { messages: Message[] }) { for (const c of steps[i++] ?? [{ type: 'text-delta', text: 'done' } as ModelChunk, fin('stop')]) yield c } }
}

// 每道题一个"演员"：诚实地修好 / 什么都不改就说完成了 / 改测试蒙混过关
const script: Record<string, ModelChunk[][]> = {
  'fix-off-by-one': [
    [call('c1', 'edit', { path: 'lib.js', old_string: 'i < n', new_string: 'i <= n' }), fin('tool-calls')],
    [call('c2', 'bash', { command: 'node test.js' }), fin('tool-calls')],
    [{ type: 'text-delta', text: '改成 <=，测试通过。' }, fin('stop')],
  ],
  'add-slugify': [[{ type: 'text-delta', text: '已经实现了。' }, fin('stop')]],
  'fix-missing-await': [
    [call('c1', 'write', { path: 'test.js', content: "console.log('ok')\n" }), fin('tool-calls')],
    [{ type: 'text-delta', text: '测试通过了。' }, fin('stop')],
  ],
}

test('eval 端到端：真 runtime + 真 sqlite + 真 local 沙箱 + 真内置任务；诚实修好的通过，没改的和改测试作弊的都不通过', { timeout: 60_000 }, async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'hue-evalex-')), 'eval.db')
  const tasks = codingTasks().filter(t => t.id in script)
  const results = await runEval(tasks, {
    run: agentRunner({ model: job => scripted(script[job.task.id]!), db, policy: presets.yolo() }),
    sandbox: async dir => local({ root: dir }), runId: 'x',
  })
  try {
    assert.deepEqual(Object.fromEntries(results.map(r => [r.taskId, r.status])), { 'fix-off-by-one': 'pass', 'fix-missing-await': 'fail', 'add-slugify': 'fail' })
    const by = Object.fromEntries(results.map(r => [r.taskId, r]))
    assert.equal(by['fix-off-by-one']!.metrics.steps, 3); assert.equal(by['fix-off-by-one']!.metrics.toolCalls, 2)
    assert.equal(by['add-slugify']!.layer, 'wrong-result'); assert.match(by['fix-missing-await']!.detail!, /undefined|AssertionError|Expected/)

    // 每次试跑的完整日志都在 sqlite 里，会话 id 就是报告里给的那个
    const store = sqliteStore(db)
    const log: HueEvent[] = []; for await (const e of store.read('eval-x-fix-off-by-one-1')) log.push(e); store.close()
    assert.deepEqual(log.filter(e => e.type !== 'ext').map(e => e.type).slice(0, 3), ['session.created', 'turn.started', 'user.message'])
    assert.deepEqual(log.filter(e => e.type === 'model.message').length, by['fix-off-by-one']!.events.filter(e => e.type === 'model.message').length)

    const md = formatReport(summarize(results), { model: 'mock' })
    assert.match(md, /成功 1\/3（33%）/); assert.match(md, /### 1\. fix-missing-await #1 — fail \/ wrong-result/)
  } finally { for (const r of results) if (r.dir && existsSync(r.dir)) rmSync(r.dir, { recursive: true, force: true }) }
})
