import { HueFault } from '@hue/core'
import type { Json, Tool, ToolOutput } from '@hue/core'
import type { Agent } from './agent.js'
import { drain } from './agent.js'

export interface SubagentOptions {
  /** 子 agent 本身，用另一个 createAgent 建（自己的模型、工具、指令）。不给它这个工具，它就不能再派子 agent。 */
  agent: Agent
  name?: string
  description?: string
  /**
   * 派活这个调用对父 agent 算什么副作用。默认 'unsafe'（串行、policy 会问）。
   * 子 agent 的工具全是只读的（搜索、调研）就设 'none'：同一步里派的多个子 agent 会并发跑。
   */
  effects?: Tool['effects']
  /** 同时在跑的子 agent 上限，超出的排队。默认 4。 */
  maxConcurrent?: number
}

/**
 * 把一个 agent 包成工具。子 agent 有自己的会话（独立上下文，session.created 里记着父会话的 callId），
 * 和父 agent 共用同一个 store，所以事件树在日志里就是几个会话用 parent 连起来。
 * 父 agent 只看到最后一条回复，中间过程不进它的上下文。
 */
export function subagentTool(o: SubagentOptions): Tool<{ task: string }> {
  const limit = semaphore(o.maxConcurrent ?? 4)
  return {
    name: o.name ?? 'task',
    description: o.description ?? 'Delegate a self-contained task to a sub-agent with its own context. It cannot see this conversation, so put everything it needs in `task`. Returns its final answer.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'What the sub-agent should do, with all the context it needs.' } }, required: ['task'] },
    effects: o.effects ?? 'unsafe',
    timeoutMs: 30 * 60_000,
    parse(input) {
      const task = (input as { task?: unknown } | null)?.task
      if (typeof task !== 'string' || !task.trim()) throw new Error('`task` must be a non-empty string')
      return { task }
    },
    async execute({ task }, ctx): Promise<ToolOutput> {
      const release = await limit(ctx.signal)
      try {
        const child = globalThis.crypto.randomUUID()
        const r = await drain(
          o.agent.run(task, { sessionId: child, signal: ctx.signal, parent: { sessionId: ctx.sessionId, turnId: ctx.turnId, callId: ctx.callId } }),
          e => { if (e.type === 'tool.call') ctx.progress({ subagent: child, tool: e.name }) },
        )
        const last = r.state.transcript.at(-1)
        const answer = last?.role === 'assistant' ? last.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('') : ''
        const data = { sessionId: child, reason: r.reason, steps: r.steps, usage: r.usage } as unknown as Json
        if (r.reason === 'stop') return { content: [{ type: 'text', text: answer || '(the sub-agent finished without a reply)' }], data }
        const why = r.error ? `${r.reason}: ${r.error.message}` : r.reason
        return { content: [{ type: 'text', text: `The sub-agent did not finish (${why}).${answer ? ` Its last words: ${answer}` : ''}` }], isError: true, data }
      } finally { release() }
    },
  }
}

/** 最多 n 个同时持有；等待的人可以被信号取消。 */
function semaphore(n: number): (signal: AbortSignal) => Promise<() => void> {
  let free = n; const waiting: Array<() => void> = []
  const release = () => { const next = waiting.shift(); if (next) next(); else free++ }
  return signal => {
    if (signal.aborted) return Promise.reject(new HueFault({ code: 'interrupted', message: 'aborted' }))
    if (free > 0) { free--; return Promise.resolve(release) }
    return new Promise((resolve, reject) => {
      const grant = () => { signal.removeEventListener('abort', cancel); resolve(release) }
      const cancel = () => { waiting.splice(waiting.indexOf(grant), 1); reject(new HueFault({ code: 'interrupted', message: 'aborted' })) }
      waiting.push(grant); signal.addEventListener('abort', cancel, { once: true })
    })
  }
}
