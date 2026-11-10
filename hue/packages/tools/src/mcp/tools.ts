import { isAbort, textResult } from '@hue/core'
import type { Effects, InputResponse, Json, Tool, ToolContent, ToolContext, ToolOutput } from '@hue/core'
import { McpError } from './errors.js'
import type { Client } from './client.js'
import { TransportError } from './transport.js'

export interface McpToolDef {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean }
}

export interface AdaptOptions {
  /** 工具名前缀：<server>__<tool>。 */
  server: string
  /** 按工具名覆盖 effects（优先于 annotations）。 */
  effects?: Record<string, Effects>
  /** annotations 是 server 自己报的，规范说除非 server 可信否则不能信。设成 false 则一律 unsafe（覆盖表仍生效）。默认 true。 */
  trustAnnotations?: boolean
  /** 最多问几轮 input_required，默认 5。 */
  maxInputRounds?: number
  /** HTTP 才有：x-mcp-header 的映射。 */
  http?: boolean
}

const API_NAME = /[^a-zA-Z0-9_-]/g

/** 只读 → none，幂等 → idempotent，其余（包括没写）→ unsafe。 */
export function effectsOf(def: McpToolDef, o: Pick<AdaptOptions, 'effects' | 'trustAnnotations'>): Effects {
  const forced = o.effects?.[def.name]
  if (forced) return forced
  if (o.trustAnnotations === false) return 'unsafe'
  return def.annotations?.readOnlyHint ? 'none' : def.annotations?.idempotentHint ? 'idempotent' : 'unsafe'
}

// ───────────── x-mcp-header（只在 HTTP 上用）─────────────

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** 返回 undefined 表示合法，否则是拒绝这个工具的理由。 */
export function checkHeaderAnnotations(schema: unknown): string | undefined {
  const seen = new Set<string>()
  let problem: string | undefined
  const walk = (node: unknown, reachable: boolean): void => {
    if (problem || !node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(x => walk(x, false)); return }
    const rec = node as Record<string, unknown>
    if ('x-mcp-header' in rec) {
      const h = rec['x-mcp-header']
      if (!reachable) problem = 'x-mcp-header outside the properties chain'
      else if (typeof h !== 'string' || !TOKEN.test(h)) problem = `invalid x-mcp-header ${JSON.stringify(h)}`
      else if (seen.has(h.toLowerCase())) problem = `duplicate x-mcp-header "${h}"`
      else if (!['string', 'integer', 'boolean'].includes(rec.type as string)) problem = `x-mcp-header "${h}" on a non-primitive or number property`
      else seen.add(h.toLowerCase())
    }
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'properties' && v && typeof v === 'object') for (const p of Object.values(v)) walk(p, reachable)
      else walk(v, false)
    }
  }
  walk(schema, true)
  return problem
}

export function paramHeaders(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (node: unknown, value: unknown) => {
    const rec = node as { 'x-mcp-header'?: string; properties?: Record<string, unknown> } | undefined
    if (!rec || typeof rec !== 'object' || value === undefined || value === null) return
    if (typeof rec['x-mcp-header'] === 'string') out[`Mcp-Param-${rec['x-mcp-header']}`] = String(value)
    for (const [k, sub] of Object.entries(rec.properties ?? {})) if (value && typeof value === 'object') walk(sub, (value as Record<string, unknown>)[k])
  }
  walk(schema, args)
  return out
}

// ───────────── 结果转换 ─────────────

type McpContent = { type: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string; description?: string; resource?: { uri: string; mimeType?: string; text?: string; blob?: string } }

function convert(c: McpContent): ToolContent {
  switch (c.type) {
    case 'text': return { type: 'text', text: c.text ?? '' }
    case 'image': return { type: 'file', mediaType: c.mimeType ?? 'image/png', url: `data:${c.mimeType ?? 'image/png'};base64,${c.data ?? ''}` }
    case 'audio': return { type: 'text', text: `[audio content (${c.mimeType ?? 'unknown type'}) omitted]` }
    case 'resource_link': return { type: 'text', text: `[resource link] ${c.name ?? ''} ${c.uri ?? ''}${c.mimeType ? ` (${c.mimeType})` : ''}${c.description ? ` — ${c.description}` : ''}`.trim() }
    case 'resource': {
      const r = c.resource
      return { type: 'text', text: r?.text !== undefined ? `[resource ${r.uri}]\n${r.text}` : `[binary resource ${r?.uri ?? ''}${r?.mimeType ? ` (${r.mimeType})` : ''} omitted]` }
    }
    default: return { type: 'text', text: `[unsupported content of type "${c.type}"]` }
  }
}

export function toOutput(result: Record<string, unknown>): ToolOutput {
  const content = ((result.content as McpContent[] | undefined) ?? []).map(convert)
  const structured = result.structuredContent as Json | undefined
  // 规范建议带 structuredContent 的工具同时给一段文本；有的 server 不给，这时模型就什么都看不到了，补一份。
  if (!content.length && structured !== undefined) content.push({ type: 'text', text: JSON.stringify(structured) })
  return { content, isError: result.isError === true, ...(structured !== undefined && { data: structured }) }
}

// ───────────── MRTR：server 要更多输入 ─────────────

type InputRequest = { method?: string; params?: { mode?: string; message?: string; requestedSchema?: Record<string, unknown> } }

/** 把一个 inputRequest 交给 core 的 InputPort 通道（ctx.requestInput）。表单类 elicitation 之外的都不支持。 */
async function answer(req: InputRequest, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (req.method !== 'elicitation/create' || (req.params?.mode ?? 'form') !== 'form') throw new McpError(-32601, `the server asked for "${req.method}${req.params?.mode ? ` (${req.params.mode})` : ''}", which this client does not support`)
  const r: InputResponse = await ctx.requestInput({ kind: 'form', prompt: req.params?.message ?? '', schema: (req.params?.requestedSchema ?? { type: 'object' }) as never })
  return r.action === 'accept' ? { action: 'accept', content: (r.value ?? {}) as object } : { action: r.action }
}

// ───────────── 适配 ─────────────

export function adapt(def: McpToolDef, client: Client, o: AdaptOptions): Tool {
  const effects = effectsOf(def, o)
  const rounds = o.maxInputRounds ?? 5

  async function callOnce(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const call = { signal: ctx.signal, name: def.name, paramHeaders: o.http ? paramHeaders(def.inputSchema, args) : undefined,
      onProgress: (p: { progress?: number; total?: number; message?: string }) => ctx.progress({ ...(p.progress !== undefined && { progress: p.progress }), ...(p.total !== undefined && { total: p.total }), ...(p.message !== undefined && { message: p.message }) }) }
    let extra: Record<string, unknown> = {}
    for (let round = 0; ; round++) {
      const r = await client.rpc('tools/call', { name: def.name, arguments: args, ...extra }, call)
      if (r.resultType !== 'input_required') return toOutput(r)
      if (round >= rounds) return textResult(`The MCP server kept asking for more input (${rounds} rounds). Giving up on "${def.name}".`, true)
      // 重发的是原请求加上这一轮的答案，不是在上一次的基础上累加。
      const requests = (r.inputRequests ?? {}) as Record<string, InputRequest>
      const inputResponses: Record<string, unknown> = {}
      for (const [key, req] of Object.entries(requests)) inputResponses[key] = await answer(req, ctx)
      extra = { ...(Object.keys(requests).length && { inputResponses }), ...(typeof r.requestState === 'string' && { requestState: r.requestState }) }
    }
  }

  return {
    name: `${o.server}__${def.name.replace(API_NAME, '_')}`.slice(0, 64),
    description: def.description ?? def.name,
    inputSchema: def.inputSchema as never,
    effects,
    parse(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('arguments must be a JSON object')
      return input as Record<string, unknown> as never
    },
    async execute(input, ctx) {
      const args = input as unknown as Record<string, unknown>
      const failed = (e: unknown): ToolOutput => {
        if (e instanceof McpError) return textResult(`MCP error ${e.code}: ${e.message}`, true)
        throw e
      }
      try { return await callOnce(args, ctx) } catch (e) {
        if (isAbort(e) || !(e instanceof TransportError)) return failed(e)
        // 连接断了：请求有没有被执行是未知的。可重复的工具换个新请求 ID 再发一次；不可重复的不能赌。
        if (effects === 'unsafe') return textResult(`The connection to MCP server "${o.server}" was lost while "${def.name}" was running, so it is unknown whether it took effect. Check the current state before retrying.`, true)
        try { return await callOnce(args, ctx) } catch (e2) {
          if (e2 instanceof TransportError) return textResult(`The connection to MCP server "${o.server}" was lost twice while running "${def.name}": ${e2.message}`, true)
          return failed(e2)
        }
      }
    },
  }
}

// ───────────── tools/list 缓存 ─────────────

export function toolLister(client: Client, ttlFallbackMs: number, now: () => number = Date.now) {
  let cache: { tools: McpToolDef[]; expires: number } | undefined, inflight: Promise<McpToolDef[]> | undefined
  async function fetchAll(signal: AbortSignal): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = []
    let cursor: string | undefined, ttl = Infinity
    for (let page = 0; page < 20; page++) {
      const r = await client.rpc('tools/list', cursor ? { cursor } : {}, { signal })
      tools.push(...((r.tools as McpToolDef[] | undefined) ?? []))
      ttl = Math.min(ttl, typeof r.ttlMs === 'number' ? r.ttlMs : ttlFallbackMs)
      cursor = r.nextCursor as string | undefined
      if (!cursor) break
    }
    cache = { tools, expires: now() + (Number.isFinite(ttl) ? ttl : ttlFallbackMs) }
    return tools
  }
  return {
    // 顺序就是 server 给的顺序：工具列表是 prompt cache 前缀的一部分，不排序。
    list(signal: AbortSignal): Promise<McpToolDef[]> {
      if (cache && now() < cache.expires) return Promise.resolve(cache.tools)
      inflight ??= fetchAll(signal).finally(() => { inflight = undefined })
      return inflight
    },
  }
}
