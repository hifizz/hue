/**
 * 第三层：流式 agent loop。
 *
 * 和第 1 课的循环结构完全一样（请求 → 执行工具 → 追加 → 再请求），区别只有一处：
 * "请求模型"不再是一次 await，而是 `for await` 消费一串 Chunk，边收边往外吐事件，
 * 同时在本地把碎片拼成一条完整的 assistant 消息。
 *
 * 流式带来三个新问题，都在这里处理：
 *   1. 回复可能只收到一半（断网、被取消、服务端报错）。这时什么该进历史，什么不该？
 *   2. 推理块带签名，必须原样进历史、原样发回，否则下一轮会被 provider 拒绝。
 *   3. 工具参数可能是坏的（被 max_tokens 截断），要当作错误回给模型，而不是崩溃或执行。
 */
import { runTool, type Tool, type ToolCallPart, type ToolResultPart, type ToolSpec } from '../01-minimal-loop/loop.js'
import type { AssistantMessage, FinishReason, Json, Message, StreamingModel, Usage } from './types.js'

export type LoopEvent =
  | { type: 'step.start'; step: number }
  // 这三种 delta 只用来给 UI 实时显示。历史里的内容不靠它们，靠下面的 assistant 事件。
  | { type: 'text-delta'; step: number; text: string }
  | { type: 'reasoning-delta'; step: number; text: string }
  | { type: 'tool-input-delta'; step: number; callId: string; name: string; delta: string }
  | { type: 'assistant'; step: number; message: AssistantMessage; finishReason: FinishReason | 'aborted' | 'error'; usage: Usage }
  | { type: 'tool.call'; step: number; call: ToolCallPart }
  | { type: 'tool.result'; step: number; result: ToolResultPart }

export type StopReason = 'stop' | 'length' | 'max_steps' | 'aborted' | 'error'
export interface LoopResult {
  reason: StopReason
  /** 最后一步模型自己给的结束原因。比如 'content-filter'（拒答）时 reason 仍是 'stop'，看这个才能区分。 */
  finishReason?: FinishReason
  steps: number
  usage: Usage
  messages: Message[]
  error?: string
}

export interface LoopOptions {
  model: StreamingModel
  system: string
  tools: Tool[]
  prompt: string
  history?: Message[]
  maxSteps?: number
  signal?: AbortSignal
}

const add = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
})

export async function* streamingLoop(o: LoopOptions): AsyncGenerator<LoopEvent, LoopResult> {
  const messages: Message[] = [...(o.history ?? []), { role: 'user', content: o.prompt }]
  const specs: ToolSpec[] = o.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  const maxSteps = o.maxSteps ?? 10
  const signal = o.signal ?? new AbortController().signal
  let step = 0
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }
  const done = (reason: StopReason, extra: Partial<LoopResult> = {}): LoopResult => ({ reason, steps: step, usage, messages, ...extra })

  while (true) {
    if (signal.aborted) return done('aborted')
    step++
    yield { type: 'step.start', step }

    // ── ① 消费流，同时拼装 assistant 消息 ──
    const content: AssistantMessage['content'] = []
    let text = '' // 正在累积的文本块
    let reasoning = '' // 正在累积的推理块
    let finish: Extract<import('./types.js').Chunk, { type: 'finish' }> | undefined
    let failure: string | undefined
    // 文本和推理都可能在同一条回复里交替出现，所以换类型之前要先把前一类"收口"成一个 part。
    const flushText = () => { if (text) { content.push({ type: 'text', text }); text = '' } }

    try {
      for await (const c of o.model.stream({ system: o.system, messages, tools: specs }, signal)) {
        switch (c.type) {
          case 'text-delta': text += c.text; yield { type: 'text-delta', step, text: c.text }; break
          case 'reasoning-delta': flushText(); reasoning += c.text; yield { type: 'reasoning-delta', step, text: c.text }; break
          // 推理块只有在 reasoning-end 到达时才算完整（签名在这时才有）。不完整的推理块不进历史。
          case 'reasoning-end': content.push({ type: 'reasoning', text: reasoning, providerMetadata: c.providerMetadata }); reasoning = ''; break
          case 'tool-input-delta': yield { type: 'tool-input-delta', step, callId: c.callId, name: c.name, delta: c.delta }; break
          case 'tool-call': flushText(); content.push({ type: 'tool-call', callId: c.callId, name: c.name, input: c.input }); break
          case 'finish': finish = c; break
          case 'error': failure = c.message; break
        }
        if (finish || failure) break // finish 约定是最后一块；error 之后也不再信任后续内容
      }
    } catch (e) {
      // 取消会让底层流抛 AbortError。这不是故障，是用户的意图。
      if (!signal.aborted) failure = e instanceof Error ? e.message : String(e)
    }
    flushText()

    // ── ② 没有 finish = 回复不完整（被取消 / 服务端错误 / 流提前断开）──
    if (!finish) {
      // 只保留已经完整的文本。不完整回复里的 tool-call 不能留：
      // 历史里有 tool-call 却没有 tool-result，下一次请求会被 provider 直接拒绝。
      // 没有 reasoning-end 的推理块、缺签名的推理块也不能留，原因同上。
      const partial = content.filter(p => p.type === 'text')
      const aborted = signal.aborted
      if (partial.length) {
        const message: AssistantMessage = { role: 'assistant', content: partial }
        messages.push(message)
        yield { type: 'assistant', step, message, finishReason: aborted ? 'aborted' : 'error', usage: { inputTokens: 0, outputTokens: 0 } }
      }
      return aborted ? done('aborted') : done('error', { error: failure ?? 'stream ended without finish' })
    }

    usage = add(usage, finish.usage)

    // ── ③ 被 max_tokens 截断：tool-call 的参数可能不完整，不执行也不进历史 ──
    if (finish.finishReason === 'length') {
      const partial = content.filter(p => p.type === 'text')
      if (partial.length) {
        const message: AssistantMessage = { role: 'assistant', content: partial }
        messages.push(message)
        yield { type: 'assistant', step, message, finishReason: 'length', usage: finish.usage }
      }
      return done('length', { finishReason: 'length' })
    }

    // ── ④ 完整回复：进历史（推理块的签名原样保留在 content 里）──
    const message: AssistantMessage = { role: 'assistant', content }
    messages.push(message)
    yield { type: 'assistant', step, message, finishReason: finish.finishReason, usage: finish.usage }

    const calls = content.filter((p): p is ToolCallPart => p.type === 'tool-call')
    if (calls.length === 0) return done('stop', { finishReason: finish.finishReason })

    // ── ⑤ 执行工具（同第 1 课）──
    for (const call of calls) yield { type: 'tool.call', step, call }
    const results = await Promise.all(calls.map(c => runCall(o.tools, c, signal)))
    for (const result of results) yield { type: 'tool.result', step, result }
    messages.push({ role: 'tool', content: results })

    if (step >= maxSteps) return done('max_steps', { finishReason: finish.finishReason })
  }
}

/**
 * 第 1 课的 runTool 之前多一道检查：适配器遇到解析不了的参数时给的是 { __raw: 原文 }。
 * 这里把它变成明确的错误结果交给模型，模型通常会用更短的参数重试。
 * 注意：不能"尽量修一下 JSON 然后执行"，参数被截断时猜出来的值可能是错的，比如路径少了半截。
 */
function runCall(tools: Tool[], call: ToolCallPart, signal: AbortSignal): Promise<ToolResultPart> {
  if (isRaw(call.input)) {
    const text = `Invalid input for ${call.name}: arguments are not valid JSON (possibly truncated). Raw: ${call.input.__raw.slice(0, 200)}`
    return Promise.resolve({ type: 'tool-result', callId: call.callId, name: call.name, text, isError: true })
  }
  return runTool(tools, call, signal)
}
const isRaw = (v: Json): v is { __raw: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { __raw?: unknown }).__raw === 'string'

export async function drain(gen: AsyncGenerator<LoopEvent, LoopResult>): Promise<[LoopEvent[], LoopResult]> {
  const events: LoopEvent[] = []
  while (true) {
    const n = await gen.next()
    if (n.done) return [events, n.value]
    events.push(n.value)
  }
}
