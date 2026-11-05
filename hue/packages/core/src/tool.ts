import type { Json, JsonSchema } from './json.js'
import type { ToolContent } from './message.js'
import type { InputRequest, InputResponse } from './ports.js'
import type { SandboxPort } from './ports.js'

/**
 * 副作用等级。决定三件事：能否并发、断流/崩溃后能否自动重跑、policy 的默认态度。
 * - none：纯读（read_file、grep、tools/list）——可并发、可重跑
 * - idempotent：重复执行结果相同（写入固定内容到固定路径）——串行、可重跑
 * - unsafe：不可重复（bash、发消息、付款）——串行、不自动重跑
 */
export type Effects = 'none' | 'idempotent' | 'unsafe'

export interface Tool<I = Json, O extends Json = Json> {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly effects: Effects
  /**
   * 校验并收窄参数。core 不带 JSON Schema 校验器（零依赖），由工具自己提供（@hue/tools 用 zod / ajv 生成）。
   * 不提供则原样当 I 用。抛错 → invalid_tool_input，错误信息回给模型让它重试。
   */
  parse?(input: Json): I
  execute(input: I, ctx: ToolContext): Promise<ToolOutput<O>>
  /** 超时，默认由 loop 的 toolTimeoutMs 决定。 */
  readonly timeoutMs?: number
}

export interface ToolOutput<O extends Json = Json> {
  /** 给模型看的 */
  content: ToolContent[]
  isError?: boolean
  /** 给程序 / UI 看的结构化结果，不发给模型（MCP 的 structuredContent 可放这里） */
  data?: O
}

export interface ToolContext {
  readonly signal: AbortSignal
  readonly sessionId: string
  readonly turnId: string
  readonly callId: string
  /** 工具里所有 I/O 都应该走 sandbox，这样换执行环境不用改工具。 */
  readonly sandbox?: SandboxPort
  /** 进度（不落盘，只给 UI）。 */
  progress(data: Json): void
  /**
   * 向"上面"要输入：用户确认、表单、MCP 的 MRTR input_required 都走这里。
   * 没有 InputPort 时 reject（code: input_unavailable）。
   */
  requestInput(request: InputRequest): Promise<InputResponse>
}

export const textResult = (text: string, isError = false): ToolOutput => ({ content: [{ type: 'text', text }], isError })
