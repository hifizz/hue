/**
 * 第 1 课：最小 agent loop（教学版，自包含，不依赖 @hue/core）。
 *
 * 先记住三句话：
 *   1. 模型无状态。每次请求都要把完整的 messages 重新发一遍。
 *   2. 模型不会执行任何东西。它只会"说"想调哪个工具；执行的是你的代码。
 *   3. 所以 agent loop 就是：请求模型 → 有工具调用就执行 → 把结果追加进 messages → 再请求。
 *      每一次"请求模型"叫一个 step。
 *
 * 对应关系：这个文件 ≈ AI SDK 里 streamText 在 stopWhen 之外的那个 while 循环，
 * 也是 hue/packages/core/src/loop.ts 去掉一切加固之后剩下的骨架。
 */

// ───────────────────────── 1. 数据：一切都是 messages ─────────────────────────

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface TextPart { type: 'text'; text: string }
export interface ToolCallPart { type: 'tool-call'; callId: string; name: string; input: Json }
export interface ToolResultPart { type: 'tool-result'; callId: string; name: string; text: string; isError: boolean }

// user 的 content 在 Hue 里是 parts（可带图片），这里简化成字符串。
export type UserMessage = { role: 'user'; content: string }
export type AssistantMessage = { role: 'assistant'; content: Array<TextPart | ToolCallPart> }
// 一个 tool 消息装"同一步里所有工具的结果"。
export type ToolMessage = { role: 'tool'; content: ToolResultPart[] }
export type Message = UserMessage | AssistantMessage | ToolMessage

// ───────────────────────── 2. 两个接口：模型和工具 ─────────────────────────

export interface ToolSpec { name: string; description: string; inputSchema: Json }

export interface Tool extends ToolSpec {
  /** 返回给模型看的文本。抛错也行，loop 会接住并转成错误结果。 */
  execute(input: Json, signal: AbortSignal): Promise<string>
}

export interface ModelRequest { system: string; messages: Message[]; tools: ToolSpec[] }
export interface ModelReply {
  message: AssistantMessage
  /** 'tool-calls' = 想调工具；'stop' = 说完了；'length' = 撞到 maxOutputTokens 被截断 */
  finishReason: 'stop' | 'tool-calls' | 'length'
}

/**
 * 这里用一次返回完整结果的 complete()，是为了先看清循环本身。
 * Hue 的 ModelPort 是流式的（stream() 吐 chunk），那是第 2 课。
 */
export interface Model {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>
}

// ───────────────────────── 3. 事件：loop 对外说了什么 ─────────────────────────

export type LoopEvent =
  | { type: 'step.start'; step: number }
  | { type: 'assistant'; step: number; message: AssistantMessage }
  | { type: 'tool.call'; step: number; call: ToolCallPart }
  | { type: 'tool.result'; step: number; result: ToolResultPart }

export type StopReason = 'stop' | 'length' | 'max_steps' | 'aborted'
export interface LoopResult { reason: StopReason; steps: number; messages: Message[] }

export interface LoopOptions {
  model: Model
  system: string
  tools: Tool[]
  prompt: string
  /** 之前的对话。模型无状态，续聊就是把旧 messages 再发一遍。 */
  history?: Message[]
  /** 保险丝：模型可能一直调工具停不下来，每一步都要重发整个对话，成本只增不减。 */
  maxSteps?: number
  signal?: AbortSignal
}

// ───────────────────────── 4. loop 本体 ─────────────────────────

export async function* agentLoop(o: LoopOptions): AsyncGenerator<LoopEvent, LoopResult> {
  const messages: Message[] = [...(o.history ?? []), { role: 'user', content: o.prompt }]
  const specs: ToolSpec[] = o.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  const maxSteps = o.maxSteps ?? 10
  const signal = o.signal ?? new AbortController().signal
  let step = 0
  const done = (reason: StopReason): LoopResult => ({ reason, steps: step, messages })

  while (true) {
    if (signal.aborted) return done('aborted')
    step++
    yield { type: 'step.start', step }

    // ① 一个 step = 一次模型调用。传的是"全部 messages"，因为模型什么都不记得。
    let reply: ModelReply
    try {
      reply = await o.model.complete({ system: o.system, messages, tools: specs }, signal)
    } catch (e) {
      if (signal.aborted) return done('aborted') // 取消导致的异常不是错误
      throw e
    }
    const { message, finishReason } = reply
    yield { type: 'assistant', step, message }

    // ② 被截断时，里面的 tool-call 可能只有一半参数，不能执行，也不能留在历史里：
    //    历史里有 tool-call 却没有对应的 tool-result，下一次请求 provider 会直接拒绝。
    if (finishReason === 'length') {
      const text = message.content.filter(p => p.type === 'text')
      if (text.length) messages.push({ role: 'assistant', content: text })
      return done('length')
    }
    messages.push(message)

    // ③ 退出条件：这一步没有工具调用，说明模型认为自己说完了。
    const calls = message.content.filter((p): p is ToolCallPart => p.type === 'tool-call')
    if (calls.length === 0) return done('stop')

    // ④ 执行工具。先把所有 tool.call 都发出去再开始执行
    //    （消费者可以在这个时间点落盘，崩溃后就知道"执行过什么"。这是 Hue 的写前日志的雏形）。
    for (const call of calls) yield { type: 'tool.call', step, call }
    const results = await Promise.all(calls.map(c => runTool(o.tools, c, signal)))
    for (const result of results) yield { type: 'tool.result', step, result }

    // ⑤ 结果追加进 messages，顺序 = calls 的顺序（Promise.all 保证，与谁先跑完无关）。
    messages.push({ role: 'tool', content: results })

    // ⑥ 保险丝。放在追加结果之后，保证 messages 里 tool-call 和 tool-result 总是成对的。
    if (step >= maxSteps) return done('max_steps')
  }
}

/**
 * 工具永远不让 loop 抛错：未知工具、参数不对、执行失败，全部变成 isError 的结果交给模型。
 * 原因有两个：
 *   - API 要求每个 tool-call 都必须有一个 tool-result，少一个下一次请求就会 400。
 *   - 模型看到错误信息后常常能自己纠正（换个参数、换个工具），抛错就丢掉了这个机会。
 */
async function runTool(tools: Tool[], call: ToolCallPart, signal: AbortSignal): Promise<ToolResultPart> {
  const fail = (text: string): ToolResultPart => ({ type: 'tool-result', callId: call.callId, name: call.name, text, isError: true })
  const tool = tools.find(t => t.name === call.name)
  if (!tool) return fail(`Unknown tool "${call.name}". Available: ${tools.map(t => t.name).join(', ')}`)
  try {
    const text = await tool.execute(call.input, signal)
    return { type: 'tool-result', callId: call.callId, name: call.name, text, isError: false }
  } catch (e) {
    return fail(`Error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * for await 拿不到 generator 的 return 值（LoopResult），所以需要手动 next()。
 * 返回 [所有事件, 最终结果]。
 */
export async function drain(gen: AsyncGenerator<LoopEvent, LoopResult>): Promise<[LoopEvent[], LoopResult]> {
  const events: LoopEvent[] = []
  while (true) {
    const n = await gen.next()
    if (n.done) return [events, n.value]
    events.push(n.value)
  }
}
