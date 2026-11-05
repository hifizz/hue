import type { Json } from './json.js'
import type { AssistantMessage, ToolCallPart, ToolContent, UserMessage } from './message.js'
import { toolCallsOf } from './message.js'
import type { ModelPort, ModelSettings, ToolSpec, Usage } from './model.js'
import { addUsage, emptyUsage } from './model.js'
import type { Tool, ToolContext, ToolOutput } from './tool.js'
import type { Capability, ContextStrategy, InputPort, PolicyPort, SandboxPort, InputRequest, InputResponse } from './ports.js'
import type { EventInit, HueEvent, TurnEndReason } from './event.js'
import { HUE_EVENT_VERSION, isDurable } from './event.js'
import type { ConversationState } from './fold.js'
import { modelView, reduce } from './fold.js'
import type { StopCondition } from './stop.js'
import type { HueError } from './errors.js'
import { HueFault, toHueError } from './errors.js'
import { AsyncQueue } from './queue.js'

export interface TurnOptions {
  sessionId: string
  /** fold(store.read(sessionId)) 的结果。loop 会在它上面继续折自己的事件。 */
  state: ConversationState
  input: UserMessage
  model: ModelPort
  instructions?: string
  tools?: Tool[]
  capabilities?: Capability[]
  context?: ContextStrategy
  policy?: PolicyPort
  inputPort?: InputPort
  sandbox?: SandboxPort
  stopWhen?: StopCondition[]
  /** 硬上限，默认 50 */
  maxSteps?: number
  /** 默认 120s */
  toolTimeoutMs?: number
  settings?: ModelSettings
  /** 每步之间拉取用户插话（steer）。队列归 runtime，core 只负责在安全点取。 */
  pullSteer?: () => UserMessage[]
  signal?: AbortSignal
  /** 可注入，便于确定性测试 */
  now?: () => number
  newId?: () => string
}

export interface TurnResult {
  reason: TurnEndReason
  usage: Usage
  steps: number
  state: ConversationState
  error?: HueError
}

/**
 * 一个 turn：一条用户输入 → 若干步（模型调用 + 工具执行）→ 结束。
 *
 * 拉取即落盘：这是一个 async generator，消费者每 `next()` 一次 loop 才往前走。
 * 消费者只要在调用下一次 next() 之前 `await store.append(e)`，
 * 就保证了 tool.call 在工具真正执行前已经落盘（写前日志），崩溃后可识别。
 *
 * 自举一致：loop 用 reduce 折叠自己发出的 durable 事件维护 state，
 * 所以 turn 结束时的 state 恒等于 fold(日志)。
 */
export async function* runTurn(o: TurnOptions): AsyncGenerator<HueEvent, TurnResult> {
  const now = o.now ?? Date.now
  const newId = o.newId ?? (() => globalThis.crypto.randomUUID())
  const signal = o.signal ?? new AbortController().signal
  const maxSteps = o.maxSteps ?? 50
  const turnId = newId()
  let state = o.state
  let seq = state.lastSeq
  let usage = emptyUsage()
  let step = 0

  const make = (init: EventInit): HueEvent => {
    const e = { v: HUE_EVENT_VERSION, id: newId(), sessionId: o.sessionId, seq: 0, at: now(), turnId, ...init } as HueEvent
    if (isDurable(e)) { e.seq = ++seq; state = reduce(state, e) }
    return e
  }
  const end = (reason: TurnEndReason, error?: HueError): [HueEvent, TurnResult] => {
    const e = make({ type: 'turn.ended', turnId, reason, usage, steps: step, error })
    return [e, { reason, usage, steps: step, state, error }]
  }

  yield make({ type: 'turn.started', turnId })
  yield make({ type: 'user.message', message: o.input })

  // ── 解析能力：turn 内固定，顺序 = 声明顺序（prompt cache 友好）
  let instructions: string, tools: Map<string, Tool>
  try {
    const cctx = { sessionId: o.sessionId, turnId, input: o.input, signal }
    const caps = o.capabilities ?? []
    const parts = [o.instructions, ...(await Promise.all(caps.map(c => c.instructions?.(cctx))))]
    instructions = parts.filter(Boolean).join('\n\n')
    tools = new Map()
    for (const t of [...(o.tools ?? []), ...(await Promise.all(caps.map(c => c.tools?.(cctx) ?? []))).flat()]) {
      if (tools.has(t.name)) throw new HueFault({ code: 'internal', message: `duplicate tool name: ${t.name}` })
      tools.set(t.name, t)
    }
  } catch (err) {
    const [e, r] = end('error', toHueError(err)); yield e; return r
  }
  const specs: ToolSpec[] = [...tools.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))

  while (true) {
    if (signal.aborted) { const [e, r] = end('interrupted'); yield e; return r }
    step++

    // ── 1. 准备上下文（可能压缩；可能因超窗重来一次）
    let assistant: AssistantMessage | undefined
    let finish: { reason: string; usage: Usage } | undefined
    for (let overflowed = false; ; overflowed = true) {
      const prepared = o.context
        ? await o.context.prepare({ state, instructions, tools: specs, model: { id: o.model.id, info: o.model.info, countTokens: o.model.countTokens?.bind(o.model) }, overflowed, signal })
        : { messages: modelView(state) }
      if (prepared.compaction) {
        yield make({ type: 'context.compacted', compaction: prepared.compaction, step })
      }
      yield make({ type: 'step.started', step, estimatedTokens: prepared.estimatedTokens })

      // ── 2. 调模型（流式）
      const started = now()
      const content: AssistantMessage['content'] = []
      let text = '', reasoning = '', err: HueError | undefined
      try {
        for await (const c of o.model.stream({ instructions, messages: prepared.messages, tools: specs, settings: o.settings }, signal)) {
          switch (c.type) {
            case 'text-delta': text += c.text; yield make({ type: 'model.delta', kind: 'text', delta: c.text, step }); break
            case 'reasoning-delta': reasoning += c.text; yield make({ type: 'model.delta', kind: 'reasoning', delta: c.text, step }); break
            case 'reasoning-end': content.push({ type: 'reasoning', text: reasoning, providerMetadata: c.providerMetadata }); reasoning = ''; break
            case 'tool-input-delta': yield make({ type: 'tool.input.delta', callId: c.callId, name: c.name, delta: c.delta, step }); break
            case 'tool-call':
              if (text) { content.push({ type: 'text', text }); text = '' }
              content.push({ type: 'tool-call', callId: c.callId, name: c.name, input: c.input, providerMetadata: c.providerMetadata }); break
            case 'finish': finish = { reason: c.finishReason, usage: c.usage }; break
            case 'error': err = c.error; break
          }
        }
      } catch (e) { err = toHueError(e, 'model_error') }
      if (text) content.push({ type: 'text', text })

      if (err?.code === 'context_overflow' && !overflowed && o.context) continue
      if (err || !finish) {
        // 打断或出错：只保留已完成的文本，丢弃未执行的 tool-call 与无签名的推理（否则下一轮 provider 会拒绝）
        // TODO(deep): 打断时是否保留已发出的 tool-call 并补 interrupted 结果，让模型知道它试过什么
        const partial = content.filter(p => p.type === 'text')
        if (partial.length) yield make({ type: 'model.message', message: { role: 'assistant', content: partial }, modelId: o.model.id, finishReason: 'aborted', usage: emptyUsage(), durationMs: now() - started, step })
        const [e, r] = end(signal.aborted ? 'interrupted' : 'error', signal.aborted ? undefined : err ?? { code: 'model_error', message: 'stream ended without finish' })
        yield e; return r
      }
      assistant = { role: 'assistant', content }
      usage = addUsage(usage, finish.usage)
      yield make({ type: 'model.message', message: assistant, modelId: o.model.id, finishReason: finish.reason as never, usage: finish.usage, durationMs: now() - started, step })
      break
    }

    // ── 3. 执行工具
    const calls = toolCallsOf(assistant)
    if (calls.length) {
      for await (const e of executeCalls(calls)) yield e
    }

    // ── 4. 插话：在安全点（结果已齐）取
    const steer = o.pullSteer?.() ?? []
    for (const m of steer) yield make({ type: 'user.message', message: m, steer: true, step })

    // ── 5. 结束判断
    if (signal.aborted) { const [e, r] = end('interrupted'); yield e; return r }
    if (!calls.length && !steer.length) {
      const [e, r] = end(finish!.reason === 'length' ? 'length' : 'stop'); yield e; return r
    }
    const ctx = { step, usage, last: assistant, state }
    if (step >= maxSteps || (o.stopWhen ?? []).some(c => c(ctx))) { const [e, r] = end('stop_condition'); yield e; return r }
  }

  // ───────────────── 工具执行 ─────────────────
  /**
   * 调度：连续的 effects:'none' 调用并发成一批，其余串行，整体保持模型给出的顺序。
   * 每个调用的事件顺序：tool.call →（policy.decided）→（input.*）→ tool.progress* → tool.result
   * 不变量：每个 tool.call 恰好对应一个 tool.result（被打断 / 拒绝 / 未执行时由 loop 补 synthetic）。
   */
  async function* executeCalls(calls: ToolCallPart[]): AsyncGenerator<HueEvent> {
    const batches: ToolCallPart[][] = []
    for (const c of calls) {
      const parallel = tools.get(c.name)?.effects === 'none'
      const last = batches[batches.length - 1]
      if (parallel && last && last.every(x => tools.get(x.name)?.effects === 'none')) last.push(c)
      else batches.push([c])
    }
    for (const batch of batches) {
      if (signal.aborted) {
        for (const c of batch) {
          yield make({ type: 'tool.call', callId: c.callId, name: c.name, input: c.input, effects: tools.get(c.name)?.effects ?? 'unsafe', step })
          yield result(c, [{ type: 'text', text: 'Not run: interrupted by user.' }], { code: 'interrupted', message: 'not run' }, 0, 'not_run')
        }
        continue
      }
      // 写前日志：整批的 tool.call 先全部发出（消费者落盘后才会开始执行）
      for (const c of batch) yield make({ type: 'tool.call', callId: c.callId, name: c.name, input: c.input, effects: tools.get(c.name)?.effects ?? 'unsafe', step })
      const q = new AsyncQueue<HueEvent>()
      let pending = batch.length
      for (const c of batch) void runOne(c, q).finally(() => { if (--pending === 0) q.close() })
      for await (const e of q) yield e
    }
  }

  async function runOne(c: ToolCallPart, q: AsyncQueue<HueEvent>): Promise<void> {
    const t0 = now()
    const tool = tools.get(c.name)
    if (!tool) {
      q.push(result(c, [{ type: 'text', text: `Unknown tool "${c.name}". Available: ${[...tools.keys()].join(', ')}` }], { code: 'tool_not_found', message: c.name }, 0)); return
    }
    // 参数
    let input: unknown
    try {
      if (isRaw(c.input)) throw new Error(`arguments are not valid JSON: ${c.input.__raw.slice(0, 200)}`)
      input = tool.parse ? tool.parse(c.input) : c.input
    } catch (e) {
      q.push(result(c, [{ type: 'text', text: `Invalid input for ${c.name}: ${toHueError(e).message}` }], { code: 'invalid_tool_input', message: toHueError(e).message }, 0)); return
    }
    // 权限
    const askInput = (req: InputRequest): Promise<InputResponse> => {
      if (!o.inputPort) return Promise.reject(new HueFault({ code: 'input_unavailable', message: 'no InputPort configured' }))
      const requestId = newId()
      q.push(make({ type: 'input.requested', requestId, callId: c.callId, request: req, step }))
      return o.inputPort.request({ ...req, requestId, sessionId: o.sessionId, callId: c.callId }, signal).then(res => {
        q.push(make({ type: 'input.resolved', requestId, response: res, step })); return res
      })
    }
    if (o.policy) {
      try {
        const d = await o.policy.decide({ sessionId: o.sessionId, turnId, callId: c.callId, tool: c.name, effects: tool.effects, input: c.input }, signal)
        q.push(make({ type: 'policy.decided', callId: c.callId, decision: d, step }))
        let denied: string | undefined = d.action === 'deny' ? d.reason : undefined
        if (d.action === 'ask') {
          const res = await askInput({ kind: 'approval', prompt: d.prompt, detail: c.input })
          if (res.action !== 'accept') denied = res.action === 'decline' ? res.reason ?? 'declined by user' : 'cancelled by user'
        }
        if (denied !== undefined) {
          q.push(result(c, [{ type: 'text', text: `Denied: ${denied}` }], { code: 'policy_denied', message: denied }, now() - t0, 'denied')); return
        }
      } catch (e) {
        const he = toHueError(e)
        q.push(result(c, [{ type: 'text', text: `Not run: ${he.message}` }], he, now() - t0, he.code === 'interrupted' ? 'interrupted' : 'denied')); return
      }
    }
    // 执行
    const timeout = AbortSignal.timeout(tool.timeoutMs ?? o.toolTimeoutMs ?? 120_000)
    const ctx: ToolContext = {
      signal: AbortSignal.any([signal, timeout]), sessionId: o.sessionId, turnId, callId: c.callId, sandbox: o.sandbox,
      progress: (data: Json) => q.push(make({ type: 'tool.progress', callId: c.callId, data, step })),
      requestInput: askInput,
    }
    try {
      const out: ToolOutput = await tool.execute(input as never, ctx)
      q.push(make({ type: 'tool.result', callId: c.callId, name: c.name, content: out.content, isError: !!out.isError, data: out.data, durationMs: now() - t0, step }))
    } catch (e) {
      const he: HueError = timeout.aborted && !signal.aborted ? { code: 'tool_timeout', message: `timed out` } : toHueError(e, 'tool_error')
      q.push(result(c, [{ type: 'text', text: `Error: ${he.message}` }], he, now() - t0, he.code === 'interrupted' ? 'interrupted' : undefined))
    }
  }

  function result(c: ToolCallPart, content: ToolContent[], error: HueError, durationMs: number, synthetic?: 'interrupted' | 'denied' | 'not_run'): HueEvent {
    return make({ type: 'tool.result', callId: c.callId, name: c.name, content, isError: true, error, durationMs, synthetic, step })
  }
}

const isRaw = (v: Json): v is { __raw: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { __raw?: unknown }).__raw === 'string'
