// 运行：cd hue && npx tsx learn/01-minimal-loop/demo.ts
// 不需要 API key。模型是剧本驱动的，工具是真的（会真的算数、真的抛错）。
import { agentLoop, drain, type Tool } from './loop.js'
import { call, say, scriptedModel, useTools } from './scripted-model.js'

const calculator: Tool = {
  name: 'calc',
  description: 'Evaluate "a op b" where op is + - * /',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, op: { type: 'string' }, b: { type: 'number' } } },
  async execute(input) {
    const { a, op, b } = input as { a: number; op: string; b: number }
    if (op === '/' && b === 0) throw new Error('division by zero')
    return String({ '+': a + b, '-': a - b, '*': a * b, '/': a / b }[op])
  },
}

const { model, requests } = scriptedModel([
  // step 1: 一次说想调两个工具（并行调用）
  useTools('我来算两个数。', call('c1', 'calc', { a: 12, op: '*', b: 3 }), call('c2', 'calc', { a: 1, op: '/', b: 0 })),
  // step 2: 看到第二个失败了，换个算法
  useTools('除零了，我改算另一个。', call('c3', 'calc', { a: 36, op: '+', b: 1 })),
  // step 3: 不再调工具 → loop 结束
  say('12*3=36，36+1=37。1/0 无法计算。'),
])

const [events, result] = await drain(agentLoop({ model, system: 'You are a calculator assistant.', tools: [calculator], prompt: '算 12*3 和 1/0' }))

for (const e of events) {
  const line =
    e.type === 'step.start' ? `── step ${e.step} ──` :
    e.type === 'assistant' ? `  assistant: ${JSON.stringify(e.message.content)}` :
    e.type === 'tool.call' ? `  tool.call   ${e.call.name}(${JSON.stringify(e.call.input)})` :
    `  tool.result ${e.result.isError ? '✗' : '✓'} ${e.result.text}`
  console.log(line)
}
console.log(`\n结束原因: ${result.reason}，共 ${result.steps} 步，最终 messages ${result.messages.length} 条`)
console.log(`模型被调用 ${requests.length} 次；每次收到的 messages 条数: ${requests.map(r => r.messages.length).join(' → ')}`)
