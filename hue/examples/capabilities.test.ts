import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message, ModelChunk, ModelPort, ModelRequest } from '@hue/core'
import { file as memoryDir } from '@hue/memory'
import { local } from '@hue/sandbox'
import { fromDir as skillsDir } from '@hue/skills'
import { runAgent } from './agent.js'

const fin = (r: 'stop' | 'tool-calls'): ModelChunk => ({ type: 'finish', finishReason: r, usage: { inputTokens: 5, outputTokens: 5 } })
const call = (callId: string, name: string, input: object): ModelChunk => ({ type: 'tool-call', callId, name, input: input as never })
function scripted(steps: ModelChunk[][]): ModelPort & { requests: ModelRequest[] } {
  let i = 0; const requests: ModelRequest[] = []
  return { specVersion: 'hue.model.v1', id: 'mock:1', requests, info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
    async *stream(req) { requests.push(structuredClone(req)); for (const c of steps[i++] ?? [{ type: 'text-delta', text: 'ok' } as ModelChunk, fin('stop')]) yield c } }
}
const tmp = () => mkdtempSync(join(tmpdir(), 'hue-cap-'))
const last = (m: Message[]) => JSON.stringify(m.at(-1))

test('runtime + skills + memory：技能按需加载；第一个会话存下的偏好，第二个全新会话的提示里就有，还能 recall 正文', async () => {
  const [work, skills, mem, db] = [tmp(), tmp(), tmp(), join(tmp(), 'hue.db')]
  mkdirSync(join(skills, 'release')); writeFileSync(join(skills, 'release/SKILL.md'), '---\nname: release\ndescription: How to cut a release of this repo\n---\nRun npm version patch, then tag.\n')
  const caps = () => [skillsDir(skills), memoryDir(mem)]
  const run = async (sessionId: string, model: ModelPort) => runAgent({ model, sandbox: await local({ root: work }), task: 'hi', db, sessionId, capabilities: caps(), ask: async () => false })

  const one = scripted([
    [call('c1', 'load_skill', { name: 'release' }), fin('tool-calls')],
    [call('c2', 'remember', { name: 'commit-style', description: 'User wants conventional commits', content: 'Use feat:/fix: prefixes.' }), fin('tool-calls')],
    [{ type: 'text-delta', text: 'done' }, fin('stop')],
  ])
  const r1 = await run('s1', one)
  assert.equal(r1.reason, 'stop'); assert.equal(r1.steps, 3)
  assert.match(one.requests[0]!.instructions, /- release: How to cut a release of this repo/); assert.match(one.requests[0]!.instructions, /No notes saved yet/)
  assert.deepEqual(one.requests[0]!.tools.map(t => t.name).filter(n => ['load_skill', 'remember', 'recall', 'forget'].includes(n)).sort(), ['forget', 'load_skill', 'recall', 'remember'])
  assert.match(last(one.requests[1]!.messages), /Run npm version patch, then tag\./)
  assert.match(readFileSync(join(mem, 'commit-style.md'), 'utf8'), /description: User wants conventional commits/)

  const two = scripted([[call('c3', 'recall', { query: 'commit' }), fin('tool-calls')], [{ type: 'text-delta', text: 'ok' }, fin('stop')]])
  await run('s2', two)
  assert.match(two.requests[0]!.instructions, /- commit-style: User wants conventional commits/)
  assert.equal(two.requests[0]!.messages.length, 1, '第二个会话没有第一个会话的历史，记忆是唯一的来源')
  assert.match(last(two.requests[1]!.messages), /Use feat:\/fix: prefixes\./)
})
