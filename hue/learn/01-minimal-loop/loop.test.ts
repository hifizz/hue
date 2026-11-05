import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentLoop, drain, type Message, type Tool, type ToolMessage } from './loop.js'
import { call, say, scriptedModel, useTools } from './scripted-model.js'

const echo: Tool = {
  name: 'echo',
  description: 'echo',
  inputSchema: { type: 'object' },
  async execute(input) { return `echo:${JSON.stringify(input)}` },
}
const boom: Tool = { name: 'boom', description: 'always fails', inputSchema: { type: 'object' }, async execute() { throw new Error('kaboom') } }
const base = { system: 's', prompt: 'hi' }

test('没有工具调用：1 步结束', async () => {
  const { model } = scriptedModel([say('hello')])
  const [, r] = await drain(agentLoop({ ...base, model, tools: [] }))
  assert.equal(r.reason, 'stop')
  assert.equal(r.steps, 1)
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'assistant'])
})

test('工具循环：每一步都收到完整历史（模型无状态）', async () => {
  const { model, requests } = scriptedModel([useTools('', call('a', 'echo', { n: 1 })), say('done')])
  const [, r] = await drain(agentLoop({ ...base, model, tools: [echo] }))
  assert.equal(r.steps, 2)
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant'])
  // 第 2 次请求带着 user + assistant(tool-call) + tool(result)，一条都不能少
  assert.deepEqual(requests.map(q => q.messages.length), [1, 3])
})

test('并行调用：结果顺序 = 调用顺序，与谁先跑完无关', async () => {
  const slow: Tool = { ...echo, name: 'slow', async execute() { await new Promise(r => setTimeout(r, 30)); return 'slow' } }
  const fast: Tool = { ...echo, name: 'fast', async execute() { return 'fast' } }
  const { model } = scriptedModel([useTools('', call('1', 'slow', {}), call('2', 'fast', {})), say('ok')])
  const [, r] = await drain(agentLoop({ ...base, model, tools: [slow, fast] }))
  const tm = r.messages[2] as ToolMessage
  assert.deepEqual(tm.content.map(x => x.callId), ['1', '2'])
})

test('未知工具和工具异常：变成 isError 结果交给模型，loop 不崩', async () => {
  const { model, requests } = scriptedModel([useTools('', call('1', 'nope', {}), call('2', 'boom', {})), say('ok')])
  const [, r] = await drain(agentLoop({ ...base, model, tools: [boom] }))
  assert.equal(r.reason, 'stop')
  const tm = requests[1]!.messages[2] as ToolMessage
  assert.deepEqual(tm.content.map(x => x.isError), [true, true])
  assert.match(tm.content[0]!.text, /Unknown tool "nope"/)
  assert.match(tm.content[1]!.text, /kaboom/)
})

test('maxSteps：模型一直调工具也会停，且历史仍然成对', async () => {
  const { model } = scriptedModel(Array.from({ length: 5 }, (_, i) => useTools('', call(`c${i}`, 'echo', {}))))
  const [, r] = await drain(agentLoop({ ...base, model, tools: [echo], maxSteps: 3 }))
  assert.equal(r.reason, 'max_steps')
  assert.equal(r.steps, 3)
  assert.equal(r.messages.at(-1)!.role, 'tool') // 最后一条是工具结果，没有悬空的 tool-call
})

test('length：被截断的 tool-call 不执行、不进历史', async () => {
  let executed = false
  const spy: Tool = { ...echo, async execute() { executed = true; return '' } }
  const truncated = { ...useTools('part', call('x', 'echo', { half: true })), finishReason: 'length' as const }
  const { model } = scriptedModel([truncated])
  const [, r] = await drain(agentLoop({ ...base, model, tools: [spy] }))
  assert.equal(r.reason, 'length')
  assert.equal(executed, false)
  assert.deepEqual(r.messages.at(-1), { role: 'assistant', content: [{ type: 'text', text: 'part' }] })
})

test('abort：signal 触发后停止，不再调模型', async () => {
  const ac = new AbortController()
  const abortingTool: Tool = { ...echo, name: 'abort', async execute() { ac.abort(); return 'x' } }
  const { model, requests } = scriptedModel([useTools('', call('1', 'abort', {})), say('never reached')])
  const [, r] = await drain(agentLoop({ ...base, model, tools: [abortingTool], signal: ac.signal }))
  assert.equal(r.reason, 'aborted')
  assert.equal(requests.length, 1)
  assert.equal(r.messages.at(-1)!.role, 'tool') // 已发起的工具调用仍然有结果
})

test('续聊：history 原样发给模型', async () => {
  const { model, requests } = scriptedModel([say('second')])
  const history: Message[] = [{ role: 'user', content: 'first' }, { role: 'assistant', content: [{ type: 'text', text: 'one' }] }]
  await drain(agentLoop({ ...base, model, tools: [], history, prompt: 'again' }))
  assert.equal(requests[0]!.messages.length, 3)
})
