// 运行：cd hue && npx tsx learn/02-streaming/demo.ts
// 离线演示：把一次"带推理 + 文本 + 工具调用"的回复，以 11 字节一包的方式送进完整链路。
import type { Tool } from '../01-minimal-loop/loop.js'
import { packets, reply, textBlock, thinkingBlock, toolBlock, toSSEText, wireModel } from './fixtures.js'
import { streamingLoop } from './loop.js'

const weather: Tool = {
  name: 'get_weather',
  description: 'Get weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  async execute(input) { return `${(input as { city: string }).city}: 15°C 多云` },
}

const script = [
  reply([thinkingBlock(0, '用户问旧金山天气，我需要调用 get_weather。', 'EqQBCgIYAhIM_SIGNATURE'), textBlock(1, '我来查一下。'), toolBlock(2, 'toolu_01', 'get_weather', { city: '旧金山' })], 'tool_use', 42),
  reply([textBlock(0, '旧金山现在 15°C，多云。')], 'end_turn', 16),
]

console.log('── 第 1 步的"线上字节"，前 3 个 11 字节的包（注意事件被切得七零八落）──')
const preview = packets(toSSEText(script[0]!), 11)
for (let i = 0; i < 3; i++) console.log(JSON.stringify(new TextDecoder().decode((await preview.next()).value)))

console.log('\n── loop 事件流 ──')
const model = wireModel(script, 11)
const gen = streamingLoop({ model, system: 'You are helpful.', tools: [weather], prompt: '旧金山天气怎么样？' })
let line = ''
let kind = ''
const flush = () => { if (line) { console.log(line); line = ''; kind = '' } }
// 同一类增量接在同一行；换类型先换行
const append = (k: string, label: string, s: string, sep = '') => {
  if (kind !== k) { flush(); kind = k; line = `  ${label}: ${s}` } else line += sep + s
}
while (true) {
  const n = await gen.next()
  if (n.done) {
    flush()
    console.log(`\n结束: ${n.value.reason}，${n.value.steps} 步，usage=${JSON.stringify(n.value.usage)}`)
    console.log('第 2 次请求带的 assistant 消息:', JSON.stringify(model.requests[1]!.messages[1]))
    break
  }
  const e = n.value
  if (e.type === 'text-delta') append('text', '文本', e.text)
  else if (e.type === 'reasoning-delta') append('reasoning', '推理', e.text)
  else if (e.type === 'tool-input-delta') append('args', '参数碎片', e.delta, ' | ')
  else {
    flush()
    if (e.type === 'step.start') console.log(`── step ${e.step} ──`)
    else if (e.type === 'assistant') console.log(`  [assistant 完成] ${e.finishReason}, output_tokens=${e.usage.outputTokens}`)
    else if (e.type === 'tool.call') console.log(`  tool.call   ${e.call.name}(${JSON.stringify(e.call.input)})`)
    else if (e.type === 'tool.result') console.log(`  tool.result ${e.result.isError ? '✗' : '✓'} ${e.result.text}`)
  }
}
