// 运行：cd hue && ANTHROPIC_API_KEY=... npx tsx learn/03-real-api/live-demo.ts
// 可选环境变量：ANTHROPIC_BASE_URL（中转）、HUE_LIVE_MODEL（默认 claude-haiku-5-5）
// 会产生一次很小的真实 API 调用（两步，几百个输出 token）。没有 key 时只打印提示就退出。
import type { Tool } from '../01-minimal-loop/loop.js'
import { streamingLoop } from '../02-streaming/loop.js'
import { anthropicModel } from './client.js'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.log('没有设置 ANTHROPIC_API_KEY，跳过。离线行为见 real-api.test.ts。')
  process.exit(0)
}

const calc: Tool = {
  name: 'calc',
  description: 'Multiply two integers and return the product as text.',
  inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
  async execute(input) {
    const { a, b } = input as { a: number; b: number }
    return String(a * b)
  },
}

const model = anthropicModel({
  apiKey,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  model: process.env.HUE_LIVE_MODEL ?? 'claude-haiku-5-5',
  maxTokens: 4000, // thinking 的 token 也算在里面，别设太小
  thinking: { type: 'adaptive', display: 'summarized' },
})

const gen = streamingLoop({ model, system: 'You are a careful assistant. Use tools for arithmetic.', tools: [calc], prompt: '1234 乘以 5678 等于多少？', maxSteps: 5 })
let kind = ''
const write = (k: string, s: string) => { if (kind !== k) { process.stdout.write(`\n[${k}] `); kind = k } process.stdout.write(s) }
while (true) {
  const n = await gen.next()
  if (n.done) {
    console.log(`\n\n结束: ${n.value.reason}${n.value.error ? ` — ${n.value.error}` : ''}，${n.value.steps} 步，usage=${JSON.stringify(n.value.usage)}`)
    break
  }
  const e = n.value
  if (e.type === 'reasoning-delta') write('推理', e.text)
  else if (e.type === 'text-delta') write('文本', e.text)
  else if (e.type === 'tool.call') write('工具调用', `${e.call.name}(${JSON.stringify(e.call.input)})`)
  else if (e.type === 'tool.result') write('工具结果', e.result.text)
}
