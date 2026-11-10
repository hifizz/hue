import type { HueEvent, SandboxPort, TurnEndReason } from '@hue/core'

export interface Score { pass: boolean; detail?: string }

export interface CheckContext {
  dir: string
  /** 和 agent 用的是同一个执行环境：agent 写的代码在这里跑，不在宿主上跑。 */
  sandbox: SandboxPort
  events: HueEvent[]
  signal: AbortSignal
}

export interface EvalTask {
  id: string
  tags?: string[]
  prompt: string
  /** 覆盖整体的超时（只算 agent 跑的时间，不含 check）。 */
  timeoutMs?: number
  /** 在一个空目录里造出任务的初始状态。 */
  setup(dir: string): Promise<void>
  check(ctx: CheckContext): Promise<Score>
}

export type EvalSandbox = SandboxPort & { dispose?(): Promise<void> }

export interface AgentJob {
  task: EvalTask
  dir: string
  sessionId: string
  sandbox: SandboxPort
  signal: AbortSignal
  /** 把 agent 产生的事件交给 eval。runner 只留 durable 的。 */
  onEvent(e: HueEvent): void
}
export type AgentRunner = (job: AgentJob) => Promise<void>

/** error = 评测本身出了问题（setup 失败、沙箱起不来、runner 抛错），不是 agent 做错了。 */
export type Status = 'pass' | 'fail' | 'timeout' | 'error'

export interface Metrics {
  steps: number
  /** 含缓存读写。 */
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  toolCalls: number
  toolErrors: number
  denied: number
  compactions: number
  /** agent 跑的墙钟时间，不含 setup 和 check。 */
  durationMs: number
  endReason?: TurnEndReason
}

export interface TrialResult {
  taskId: string
  tags: string[]
  trial: number
  sessionId: string
  status: Status
  detail?: string
  /** 失败发生在哪一层的粗略判断，见 metrics.ts。 */
  layer?: string
  metrics: Metrics
  events: HueEvent[]
  /** 只有保留了工作目录（默认保留没通过的）才有。 */
  dir?: string
}
