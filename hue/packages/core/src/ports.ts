import type { Json, JsonObject } from './json.js'
import type { Message } from './message.js'
import type { ModelInfo, ModelPort, ToolSpec } from './model.js'
import type { Tool } from './tool.js'
import type { HueEvent } from './event.js'
import type { ConversationState, Compaction } from './fold.js'

// ───────────────────────── Context ─────────────────────────

/**
 * 每一步调用模型前，决定喂什么。@hue/context 实现各种策略。
 * 只读 state、不改 state；要压缩就返回 compaction，由 loop 发 context.compacted 事件落盘，
 * 下一步 fold 出来的 state 已经带着这次压缩，不会重复算。
 */
export interface ContextStrategy {
  readonly specVersion: 'hue.context.v1'
  readonly name: string
  prepare(input: ContextInput): Promise<ContextOutput>
}

export interface ContextInput {
  state: ConversationState
  instructions: string
  tools: ToolSpec[]
  model: { id: string; info: ModelInfo; countTokens?: ModelPort['countTokens'] }
  /** 上一次调用因超窗失败时为 true：策略应更激进。 */
  overflowed: boolean
  signal: AbortSignal
}

export interface ContextOutput {
  messages: Message[]
  compaction?: Compaction
  /** 估算的输入 token，进 step 事件，方便观察。 */
  estimatedTokens?: number
}

// ───────────────────────── Capability ─────────────────────────

/**
 * 能力 = 给 agent 加 instructions 和工具的东西。skills、memory、MCP server、子 agent 都是 Capability。
 * 这样 loop 不需要知道 skills / memory 是什么——它只看到"一段说明 + 一组工具"。
 *
 * 缓存友好：instructions 与 tools 每个 turn 开始时解析一次，turn 内固定；顺序 = 声明顺序。
 */
export interface Capability {
  readonly name: string
  instructions?(ctx: CapabilityContext): string | undefined | Promise<string | undefined>
  tools?(ctx: CapabilityContext): Tool[] | Promise<Tool[]>
}

export interface CapabilityContext {
  sessionId: string
  turnId: string
  /** 本 turn 的用户输入，memory 可据此做召回。 */
  input: Message
  signal: AbortSignal
}

// ───────────────────────── Policy ─────────────────────────

/** 每个工具调用执行前问一次。@hue/policy 实现；默认全部 allow。 */
export interface PolicyPort {
  readonly specVersion: 'hue.policy.v1'
  decide(call: PolicyCall, signal: AbortSignal): Promise<PolicyDecision>
}

export interface PolicyCall { sessionId: string; turnId: string; callId: string; tool: string; effects: Tool['effects']; input: Json }

export type PolicyDecision =
  | { action: 'allow'; reason?: string }
  | { action: 'deny'; reason: string }
  /** 交给 InputPort 问用户；用户的回答决定 allow / deny。 */
  | { action: 'ask'; prompt: string }

// ───────────────────────── Input（人在回路） ─────────────────────────

/**
 * 统一的"需要外部输入"通道：policy 的 ask、工具的确认、MCP MRTR 的 input_required。
 * runtime 实现（转给 UI / IM / 自动应答）。loop 会发 input.requested / input.resolved 事件。
 */
export interface InputPort {
  request(req: InputRequest & { requestId: string; sessionId: string; callId?: string }, signal: AbortSignal): Promise<InputResponse>
}

export type InputRequest =
  | { kind: 'approval'; prompt: string; detail?: Json }
  | { kind: 'form'; prompt: string; schema: JsonObject }
  | { kind: 'text'; prompt: string }

export type InputResponse =
  | { action: 'accept'; value?: Json }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' }

// ───────────────────────── Sandbox ─────────────────────────

/** 执行环境。@hue/sandbox 实现：本地进程 / Docker / E2B / Sprites。 */
export interface SandboxPort {
  readonly specVersion: 'hue.sandbox.v1'
  readonly id: string
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array | string, signal?: AbortSignal): Promise<void>
  list(path: string, signal?: AbortSignal): Promise<Array<{ name: string; type: 'file' | 'dir' }>>
}

export interface ExecOptions { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string; signal?: AbortSignal }
export interface ExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

// ───────────────────────── Store ─────────────────────────

/**
 * 事件日志。@hue/store 实现。loop 不调用它——loop 只 yield 事件，由消费者写入（见 loop.ts 的"拉取即落盘"）。
 * 只存 durable 事件（isDurable）。
 */
export interface EventStore {
  readonly specVersion: 'hue.store.v1'
  append(events: HueEvent[]): Promise<void>
  read(sessionId: string, opts?: { fromSeq?: number }): AsyncIterable<HueEvent>
  /** 最后一个 seq，没有则 0。 */
  lastSeq(sessionId: string): Promise<number>
}
