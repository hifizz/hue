import type { Json } from './json.js'

/**
 * 可序列化的错误。进事件日志的错误都用它，不用 Error 实例。
 * code 是封闭集合，便于 eval 统计"失败发生在哪一层"。
 */
export type HueErrorCode =
  | 'model_error'          // provider 报错（网络、限流、5xx）——重试归 @hue/ai，到这里已经放弃
  | 'context_overflow'     // 超出上下文窗口
  | 'tool_not_found'
  | 'invalid_tool_input'   // 参数解析或校验失败
  | 'tool_error'           // 工具执行抛错
  | 'tool_timeout'
  | 'policy_denied'
  | 'interrupted'          // AbortSignal
  | 'crashed'              // 进程崩溃后由 fold 修复出来的结果
  | 'input_unavailable'    // 需要用户输入但没有 InputPort
  | 'internal'

export interface HueError {
  code: HueErrorCode
  message: string
  retryable?: boolean
  /** 来源层，如 'ai:anthropic'、'tools:mcp'。 */
  source?: string
  data?: Json
}

export class HueFault extends Error {
  constructor(readonly error: HueError) { super(error.message) }
}

export const toHueError = (e: unknown, fallback: HueErrorCode = 'internal'): HueError => {
  if (e instanceof HueFault) return e.error
  if (isAbort(e)) return { code: 'interrupted', message: 'aborted' }
  return { code: fallback, message: e instanceof Error ? e.message : String(e) }
}

export const isAbort = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError'
