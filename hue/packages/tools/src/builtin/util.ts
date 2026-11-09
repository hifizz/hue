import { posix } from 'node:path'
import type { Effects, Json, JsonSchema, SandboxPort, Tool, ToolContext, ToolOutput } from '@hue/core'
import { textResult } from '@hue/core'

export interface ToolOptions {
  /** 相对路径的基准，也是 exec 的工作目录。不给就原样交给 sandbox（由它决定相对什么）。 */
  cwd?: string
  /** 返回给模型的文本上限（字节）。默认 30KB。 */
  maxOutputBytes?: number
}
export const DEFAULT_MAX_BYTES = 30_000

// ── 参数：同一份字段表生成 JSON Schema 和 parse，两边不会漂移 ──
export type Field = { type: 'string' | 'integer' | 'boolean'; description: string; required?: boolean; min?: number }
export type Fields = Record<string, Field>

export const schemaOf = (f: Fields): JsonSchema => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { type: v.type, description: v.description }])),
  required: Object.entries(f).filter(([, v]) => v.required).map(([k]) => k),
  additionalProperties: false,
})

/** 错误信息的读者是模型：说清楚哪个参数、期望什么，它才能改对。未知参数也拒绝（常见错误：file_path 写成 path）。 */
export function parseArgs<T>(input: Json, f: Fields): T {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('arguments must be a JSON object')
  for (const k of Object.keys(input)) if (!(k in f)) throw new Error(`unknown parameter "${k}"; expected: ${Object.keys(f).join(', ')}`)
  const out: Record<string, Json> = {}
  for (const [k, spec] of Object.entries(f)) {
    const v = input[k]
    if (v === undefined || v === null) {
      if (spec.required) throw new Error(`missing required parameter "${k}" (${spec.type})`)
      continue
    }
    if (spec.type === 'integer' ? !Number.isInteger(v) : typeof v !== spec.type) throw new Error(`parameter "${k}" must be ${spec.type}, got ${JSON.stringify(v).slice(0, 50)}`)
    if (spec.min !== undefined && (v as number) < spec.min) throw new Error(`parameter "${k}" must be >= ${spec.min}, got ${v}`)
    out[k] = v
  }
  return out as T
}

/**
 * 统一的工具外壳：先看取消，再检查 sandbox，然后才跑具体逻辑。
 * 取消放最前面：已经取消的调用不该产生任何 I/O（toolContract 也检查这点）。
 */
export function defineTool<I>(t: {
  name: string; description: string; effects: Effects; fields: Fields; timeoutMs?: number
  run(input: I, sandbox: SandboxPort, ctx: ToolContext): Promise<ToolOutput>
}): Tool<I> {
  return {
    name: t.name, description: t.description, effects: t.effects, inputSchema: schemaOf(t.fields), timeoutMs: t.timeoutMs,
    parse: input => parseArgs<I>(input, t.fields),
    async execute(input, ctx) {
      ctx.signal.throwIfAborted()
      if (!ctx.sandbox) return textResult(`${t.name} needs a sandbox, but none is configured in this environment.`, true)
      return t.run(input, ctx.sandbox, ctx)
    },
  }
}

/** 只做规范化，不拦截越界：`..` 能不能出 workdir 是 sandbox 的事（工具不是安全边界）。 */
export function resolvePath(p: string, cwd?: string): string {
  if (!p.trim()) throw new Error('path must not be empty')
  const n = posix.normalize(p)
  return cwd && !posix.isAbsolute(n) ? posix.join(cwd, n) : n
}

/** 单引号转义，用于拼 shell 命令。模型给的 pattern / path 绝不能直接拼进命令。 */
export const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const byteLength = (s: string) => Buffer.byteLength(s)

/**
 * 超长就保留头尾、中间写明省略了多少。保头尾是因为：命令输出的结尾通常是错误信息或总结，
 * 开头是上下文，中间最没信息量。结果（含提示）严格不超过 max 字节。
 * headRatio：bash 偏向结尾（错误在最后），所以它传小一点。
 */
export function truncate(text: string, max: number, hint: string, headRatio = 0.6): string {
  const buf = Buffer.from(text)
  if (buf.length <= max) return text
  const marker = `\n\n[... omitted ${buf.length} of ${buf.length} bytes from the middle. ${hint} ...]\n\n`
  const room = Math.max(0, max - byteLength(marker))
  const head = Math.floor(room * headRatio), tail = room - head
  const clean = (s: string) => s.replace(/^�+|�+$/g, '') // 切在多字节字符中间会产生 �
  const h = clean(buf.subarray(0, head).toString()), t = tail ? clean(buf.subarray(buf.length - tail).toString()) : ''
  return `${h}${marker.replace(`omitted ${buf.length} of`, `omitted ${buf.length - byteLength(h) - byteLength(t)} of`)}${t}`
}
