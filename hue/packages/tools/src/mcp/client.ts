import { HEADER_MISMATCH, McpError, MISSING_CAPABILITY, UNSUPPORTED_VERSION } from './errors.js'
import { initialize, LEGACY_VERSION, legacyHeaders } from './legacy.js'
import type { LegacyState } from './legacy.js'
import type { Reply, RpcMessage, Transport } from './transport.js'

export const PROTOCOL_VERSION = '2026-07-28'
const NS = 'io.modelcontextprotocol/'

export interface ClientOptions {
  /** 按偏好排序的、我们会说的新协议版本。默认只有 2026-07-28。 */
  versions?: string[]
  /** 对面是老 server（没有 server/discover）时回退到 2025-11-25 的握手流程，默认开。 */
  fallback?: boolean
  /** 探测对面是哪一代的超时，默认 10 秒。 */
  probeTimeoutMs?: number
  clientInfo?: { name: string; version: string }
}

type ModernState = { era: 'modern'; version: string; instructions?: string }
type State = ModernState | LegacyState

export interface CallOptions {
  signal: AbortSignal
  onProgress?: (p: { progress?: number; total?: number; message?: string }) => void
  /** HTTP 的 Mcp-Name 头（tools/call 是工具名）。 */
  name?: string
  /** 来自工具参数的 Mcp-Param-* 头。 */
  paramHeaders?: Record<string, string>
}

export type Result = Record<string, unknown> & { resultType: string }

export interface Client {
  rpc(method: string, params: Record<string, unknown>, o: CallOptions): Promise<Result>
  /** 连上并探测；返回 server 的使用说明（如果有）。 */
  connect(): Promise<string | undefined>
  /** 探测之后才有：'2026-07-28 (modern)' 或 '2025-11-25 (legacy)'。 */
  protocol(): string | undefined
  close(): Promise<void>
}

/** 不是 ASCII 可见字符、首尾有空白、或恰好长得像编码标记的值，要按规范用 Base64 哨兵格式发。 */
export function encodeHeaderValue(v: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(v) && !(v.startsWith('=?base64?') && v.endsWith('?='))
  return plain ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

const isModernError = (code?: number) => code === HEADER_MISMATCH || code === MISSING_CAPABILITY || code === UNSUPPORTED_VERSION

export function createClient(t: Transport, o: ClientOptions = {}): Client {
  const info = o.clientInfo ?? { name: 'hue', version: '0.0.0' }
  const versions = o.versions ?? [PROTOCOL_VERSION]
  // 我们能处理的 input 类型只有 elicitation 表单；sampling / roots 不声明（规范已弃用）。
  const capabilities = { elicitation: { form: {} } }
  let state: State | undefined, connecting: Promise<State> | undefined, n = 0
  t.onRestart = () => { state = undefined }

  /** 所有新协议的请求都过这里：版本、能力、身份每次都带，client 不记协议会话。 */
  const withMeta = (params: Record<string, unknown>, version: string, id: number): Record<string, unknown> => ({
    ...params,
    _meta: { ...(params._meta as object), [`${NS}protocolVersion`]: version, [`${NS}clientCapabilities`]: capabilities, [`${NS}clientInfo`]: info, progressToken: id },
  })
  const modernHeaders = (version: string, method: string, name?: string, extra?: Record<string, string>) =>
    ({ 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(name !== undefined && { 'Mcp-Name': encodeHeaderValue(name) }), ...Object.fromEntries(Object.entries(extra ?? {}).map(([k, v]) => [k, encodeHeaderValue(v)])) })
  const mutual = (supported: unknown) => versions.find(v => Array.isArray(supported) && supported.includes(v))

  async function probe(): Promise<State> {
    const signal = AbortSignal.timeout(o.probeTimeoutMs ?? 10_000)
    const legacy = async (why: string): Promise<State> => {
      if (o.fallback === false) throw new McpError(-32601, `${why}; this server does not speak ${versions[0]} and fallback to ${LEGACY_VERSION} is off`)
      return initialize(t, ++n, info, AbortSignal.timeout(o.probeTimeoutMs ?? 10_000)) // 探测的超时已经用掉了，握手另计
    }
    let version = versions[0]!
    for (let attempt = 0; ; attempt++) {
      const id = ++n
      let reply: Reply
      try {
        reply = await t.request({ jsonrpc: '2.0', id, method: 'server/discover', params: withMeta({}, version, id) }, { signal, headers: modernHeaders(version, 'server/discover') })
      } catch (e) {
        // stdio 上"没有回应"就是老 server 的表现；HTTP 上超时或网络错误是真故障。
        if (t.kind === 'stdio' && signal.aborted) return legacy('no answer to server/discover')
        throw e
      }
      const err = reply.message?.error, res = reply.message?.result as { supportedVersions?: unknown; instructions?: string } | undefined
      if (res) {
        const v = mutual(res.supportedVersions)
        if (v) return { era: 'modern', version: v, instructions: res.instructions }
        return legacy(`server supports ${JSON.stringify(res.supportedVersions)}`)
      }
      if (err?.code === UNSUPPORTED_VERSION) {
        const v = mutual((err.data as { supported?: unknown } | undefined)?.supported)
        if (v && attempt === 0 && v !== version) { version = v; continue }
        return legacy(`server supports ${JSON.stringify((err.data as { supported?: unknown } | undefined)?.supported)}`)
      }
      if (isModernError(err?.code)) throw new McpError(err!.code, err!.message, err!.data)
      // 其它错误一律当老 server（规范：不能只认 -32601）。HTTP 上只有 400/404/405 才算"这不是新协议的端点"，别的状态是真错误。
      if (t.kind === 'http' && !err && ![400, 404, 405].includes(reply.status ?? 0)) throw new McpError(-32603, `server/discover failed (HTTP ${reply.status})`)
      return legacy(err ? `server/discover failed: ${err.message}` : `server/discover answered HTTP ${reply.status}`)
    }
  }

  async function connect(): Promise<State> {
    if (state) return state
    // 同时到来的请求共用一次探测。
    connecting ??= probe().then(s => (state = s)).finally(() => { connecting = undefined })
    return connecting
  }

  async function rpc(method: string, params: Record<string, unknown>, o2: CallOptions): Promise<Result> {
    o2.signal.throwIfAborted()
    for (let attempt = 0; ; attempt++) {
      const s = await connect()
      const id = ++n
      const msg: RpcMessage = { jsonrpc: '2.0', id, method, params: s.era === 'modern' ? withMeta(params, s.version, id) : { ...params, _meta: { ...(params._meta as object), progressToken: id } } }
      const headers = s.era === 'modern' ? modernHeaders(s.version, method, o2.name, o2.paramHeaders) : legacyHeaders(s)
      // 老协议在 HTTP 上关掉连接不算取消，要发通知；stdio 的取消由 transport 自己发。
      const cancel = () => void t.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }, { headers })
      const watch = t.kind === 'http' && s.era === 'legacy'
      if (watch) o2.signal.addEventListener('abort', cancel, { once: true })
      let reply: Reply
      try {
        reply = await t.request(msg, { signal: o2.signal, headers, onNotification: m => { if (m.method === 'notifications/progress') o2.onProgress?.(m.params as never) } })
      } finally { if (watch) o2.signal.removeEventListener('abort', cancel) }

      const err = reply.message?.error
      if (err) {
        if (err.code === UNSUPPORTED_VERSION && s.era === 'modern' && attempt === 0) {
          const v = mutual((err.data as { supported?: unknown } | undefined)?.supported)
          if (v && v !== s.version) { state = { ...s, version: v }; continue }
        }
        throw new McpError(err.code, err.message, err.data)
      }
      const result = reply.message?.result
      if (!result) {
        // 老协议的会话过期：HTTP 404。重新握手后重试一次。
        if (s.era === 'legacy' && reply.status === 404 && s.session && attempt === 0) { state = undefined; continue }
        throw new McpError(-32603, `HTTP ${reply.status ?? '?'} without a JSON-RPC response`)
      }
      // 老 server 的结果没有 resultType，规范要求按 complete 处理。
      return { ...result, resultType: typeof result.resultType === 'string' ? result.resultType : 'complete' }
    }
  }

  return { rpc, connect: async () => (await connect()).instructions, protocol: () => (state ? `${state.version} (${state.era})` : undefined), close: () => t.close() }
}
