import { McpError } from './errors.js'
import type { Transport } from './transport.js'

/**
 * 2025-11-25 及更早的"有握手"协议，和新协议的差异全关在这个文件里：
 * 先 initialize、再 notifications/initialized；HTTP 上用 Mcp-Session-Id 绑会话；请求里没有 _meta 里的版本和能力。
 * 其余差异靠 client.ts 里"缺 resultType 按 complete"一条就抹平了。
 */
export const LEGACY_VERSION = '2025-11-25'

export interface LegacyState { era: 'legacy'; version: string; session?: string; instructions?: string }

export const legacyHeaders = (s: LegacyState): Record<string, string> => ({ 'MCP-Protocol-Version': s.version, ...(s.session && { 'Mcp-Session-Id': s.session }) })

export async function initialize(t: Transport, id: number, clientInfo: { name: string; version: string }, signal: AbortSignal): Promise<LegacyState> {
  // capabilities 留空：不声明 elicitation / sampling / roots，server 就不该向我们发请求。
  const reply = await t.request({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo } }, { signal })
  const r = reply.message?.result as { protocolVersion?: string; instructions?: string } | undefined
  if (!r) throw new McpError(reply.message?.error?.code ?? -32603, reply.message?.error?.message ?? `initialize failed (HTTP ${reply.status})`)
  const state: LegacyState = { era: 'legacy', version: r.protocolVersion ?? LEGACY_VERSION, session: reply.headers?.get('mcp-session-id') ?? undefined, instructions: r.instructions }
  await t.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: legacyHeaders(state) })
  return state
}
