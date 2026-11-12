import { addUsage, emptyUsage, fold, HueFault, isDurable, repairDangling, runTurn, userText } from '@hue/core'
import type {
  Capability, ContextStrategy, ConversationState, EventInit, EventStore, HueEvent, InputPort, Json, ModelPort, ModelSettings,
  PolicyPort, SandboxPort, SessionCreated, StopCondition, Tool, TurnResult, Usage, UserMessage,
} from '@hue/core'
import { limitCapability, limitTool, MAX_TOOL_OUTPUT_BYTES } from './limit.js'

export interface AgentConfig {
  model: ModelPort
  store: EventStore
  instructions?: string
  tools?: Tool[]
  capabilities?: Capability[]
  context?: ContextStrategy
  policy?: PolicyPort
  input?: InputPort
  sandbox?: SandboxPort
  stopWhen?: StopCondition[]
  maxSteps?: number
  toolTimeoutMs?: number
  /**
   * 单次工具结果发给模型的文本上限（字节），默认 100 KB；超出的保留头尾。包住所有工具，包括 capability 带来的（MCP、skills、子 agent）。
   * 传 Infinity 关掉。core 不做这件事（core 不该知道内容怎么截才不丢信息），内置工具自己还有更小的上限。
   */
  maxToolOutputBytes?: number
  settings?: ModelSettings
  /** 可注入，便于确定性测试 */
  now?: () => number
  newId?: () => string
}

export interface RunOptions {
  /** 不给就新建一个会话；给了且日志里已有，就接着聊。 */
  sessionId?: string
  signal?: AbortSignal
  /** 子 agent 才有：指向父会话里派生它的那次工具调用。 */
  parent?: SessionCreated['parent']
  meta?: Json
}

export interface RunResult extends Omit<TurnResult, 'usage' | 'steps'> {
  sessionId: string
  /** 本次 run 里跑了几个 turn（插话在 turn 结束后才到，会接着开一个）。usage 和 steps 是各 turn 之和。 */
  turns: number
  usage: Usage
  steps: number
  /** 插话了但没能送到模型的消息（turn 被打断或出错时）。由调用方决定重发还是丢弃。 */
  undelivered: UserMessage[]
}

export interface Agent {
  /**
   * 跑一个任务。每个事件在交给调用方之前已经落盘（写前日志：tool.call 在工具执行前就在盘上）。
   * 调用方提前 return() 等同于打断：会先打断、补齐日志再释放会话。
   */
  run(input: string | UserMessage, opts?: RunOptions): AsyncGenerator<HueEvent, RunResult>
  /** 运行中插话：在下一个安全点（本步的工具结果齐了之后）送给模型。会话没在跑返回 false，应该改用 run。 */
  steer(sessionId: string, input: string | UserMessage): boolean
  /** 打断会话当前的 turn。会话没在跑返回 false。 */
  interrupt(sessionId: string): boolean
  /** 从日志重建会话状态（不修复崩溃残留）。 */
  load(sessionId: string): Promise<ConversationState>
}

/** 把 run() 跑完，返回结果；onEvent 看每个事件。 */
export async function drain(g: AsyncGenerator<HueEvent, RunResult>, onEvent?: (e: HueEvent) => void): Promise<RunResult> {
  for (let n = await g.next(); ; n = await g.next()) {
    if (n.done) return n.value
    onEvent?.(n.value)
  }
}

interface Active { abort: AbortController; steer: UserMessage[] }

export function createAgent(cfg: AgentConfig): Agent {
  const now = cfg.now ?? Date.now
  const newId = cfg.newId ?? (() => globalThis.crypto.randomUUID())
  const active = new Map<string, Active>()
  const asMessage = (m: string | UserMessage): UserMessage => (typeof m === 'string' ? userText(m) : m)
  const maxOut = cfg.maxToolOutputBytes ?? MAX_TOOL_OUTPUT_BYTES
  const tools = cfg.tools?.map(t => limitTool(t, maxOut))
  const capabilities = cfg.capabilities?.map(c => limitCapability(c, maxOut))

  async function load(sessionId: string): Promise<ConversationState> {
    const events: HueEvent[] = []
    for await (const e of cfg.store.read(sessionId)) events.push(e)
    return fold(sessionId, events)
  }

  /** 补信封后落盘。seq 接在 state.lastSeq 后面。 */
  async function write(sessionId: string, state: ConversationState, inits: EventInit[]): Promise<HueEvent[]> {
    const events = inits.map((e, i) => ({ v: 1, id: newId(), sessionId, seq: state.lastSeq + 1 + i, at: now(), ...e }) as HueEvent)
    if (events.length) await cfg.store.append(events)
    return events
  }

  async function* run(input: string | UserMessage, opts: RunOptions = {}): AsyncGenerator<HueEvent, RunResult> {
    const sessionId = opts.sessionId ?? newId()
    if (active.has(sessionId)) throw new HueFault({ code: 'internal', message: `session ${sessionId} already has a running turn; use steer() to talk to it` })
    const me: Active = { abort: new AbortController(), steer: [] }
    active.set(sessionId, me)
    const signal = opts.signal ? AbortSignal.any([opts.signal, me.abort.signal]) : me.abort.signal
    let inner: AsyncGenerator<HueEvent, TurnResult> | undefined, finished = false
    const persist = async (e: HueEvent) => { if (isDurable(e)) await cfg.store.append([e]) }
    try {
      // ── 恢复：上次进程死在工具执行中途，补上"崩溃"结果，否则 tool-call 没有配对的 tool-result，provider 会拒绝。
      let state = await load(sessionId)
      const repairs = repairDangling(state)
      // 不带值为 undefined 的键：JSON 往返后键会消失，日志里读出来的事件就和写进去的不相等了。
      if (state.lastSeq === 0) repairs.unshift({ type: 'session.created', ...(opts.parent && { parent: opts.parent }), ...(opts.meta !== undefined && { meta: opts.meta }) })
      if (repairs.length) {
        const written = await write(sessionId, state, repairs)
        state = await load(sessionId)
        yield* written
      }

      let message = asMessage(input)
      let total: { usage: Usage; steps: number; turns: number } = { usage: emptyUsage(), steps: 0, turns: 0 }
      for (;;) {
        inner = runTurn({
          sessionId, state, input: message, signal, now, newId,
          model: cfg.model, instructions: cfg.instructions, tools, capabilities, context: cfg.context,
          policy: cfg.policy, inputPort: cfg.input, sandbox: cfg.sandbox, stopWhen: cfg.stopWhen, maxSteps: cfg.maxSteps,
          toolTimeoutMs: cfg.toolTimeoutMs, settings: cfg.settings, pullSteer: () => me.steer.splice(0),
        })
        let result: TurnResult
        for (let n = await inner.next(); ; n = await inner.next()) {
          if (n.done) { result = n.value; break }
          await persist(n.value) // 拉取即落盘：下一次 next() 之前先写
          yield n.value
        }
        total = { usage: addUsage(total.usage, result.usage), steps: total.steps + result.steps, turns: total.turns + 1 }
        // turn 结束的瞬间才到的插话：正常结束就接着开一个 turn，别丢。
        if (result.reason === 'stop' && me.steer.length && !signal.aborted) {
          message = { role: 'user', content: me.steer.splice(0).flatMap(m => m.content) }
          state = result.state
          continue
        }
        finished = true
        return { ...result, sessionId, ...total, undelivered: me.steer.splice(0) }
      }
    } finally {
      // 调用方中途放弃（return() / 抛错）：先打断，再把 loop 跑完并落盘，日志里不留悬空的 tool.call。
      if (!finished && inner) {
        me.abort.abort()
        try { for (let n = await inner.next(); !n.done; n = await inner.next()) await persist(n.value) } catch { /* 写盘本身坏了，没有更多办法 */ }
      }
      active.delete(sessionId)
    }
  }

  return {
    run,
    load,
    steer(sessionId, input) { const a = active.get(sessionId); if (a) a.steer.push(asMessage(input)); return !!a },
    interrupt(sessionId) { const a = active.get(sessionId); a?.abort.abort(); return !!a },
  }
}
