import type { Capability, Effects } from '@hue/core'
import { createClient } from './client.js'
import type { Client, ClientOptions } from './client.js'
import { httpTransport } from './http.js'
import type { HttpOptions } from './http.js'
import { stdioTransport } from './stdio.js'
import type { StdioOptions } from './stdio.js'
import { adapt, checkHeaderAnnotations, toolLister } from './tools.js'
import type { Transport } from './transport.js'

export interface McpOptions extends ClientOptions {
  /** 工具名前缀（<name>__<tool>）：小写字母、数字、连字符。 */
  name: string
  /** 工具列表缓存多久（server 没给 ttlMs 时），默认 60 秒。 */
  ttlMs?: number
  /** 按工具名覆盖 effects，优先于 server 的 annotations。 */
  effects?: Record<string, Effects>
  /** 是否相信 server 报的 readOnly / idempotent 标注，默认相信；设 false 则全部 unsafe。 */
  trustAnnotations?: boolean
  maxInputRounds?: number
  /** 丢掉不合格的工具时的提示（HTTP 上 x-mcp-header 不合法）。 */
  onWarning?: (message: string) => void
}

export interface McpServer extends Capability {
  /** 关闭连接；stdio 会关 stdin、等退出、不退再 SIGTERM / SIGKILL。进程退出时也会兜底杀掉。 */
  close(): Promise<void>
  /** 连上之后对面实际说的协议版本，排查用。 */
  protocol(): string | undefined
}

function server(t: Transport, o: McpOptions): McpServer {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(o.name)) throw new Error(`mcp name "${o.name}" must be lowercase letters, digits and hyphens`)
  const client: Client = createClient(t, o)
  const lister = toolLister(client, o.ttlMs ?? 60_000)
  const http = t.kind === 'http'
  return {
    name: `mcp:${o.name}`,
    // 连不上就让这个 turn 以错误结束，不悄悄少几个工具：模型会以为那些工具不存在。
    instructions: async () => (await client.connect()) || undefined,
    async tools(ctx) {
      const out = []
      for (const def of await lister.list(ctx.signal)) {
        const bad = http ? checkHeaderAnnotations(def.inputSchema) : undefined
        if (bad) { o.onWarning?.(`MCP ${o.name}: dropped tool "${def.name}": ${bad}`); continue }
        out.push(adapt(def, client, { server: o.name, effects: o.effects, trustAnnotations: o.trustAnnotations, maxInputRounds: o.maxInputRounds, http }))
      }
      return out
    },
    close: () => client.close(),
    protocol: () => client.protocol(),
  }
}

export const mcp = {
  stdio: (command: string, args: string[], o: McpOptions & StdioOptions): McpServer => server(stdioTransport(command, args, o), o),
  http: (url: string, o: McpOptions & HttpOptions): McpServer => server(httpTransport(url, o), o),
}

export { createClient, PROTOCOL_VERSION } from './client.js'
export { LEGACY_VERSION } from './legacy.js'
export { McpError } from './errors.js'
export { TransportError } from './transport.js'
export { stdioTransport } from './stdio.js'
export { httpTransport } from './http.js'
export { adapt, effectsOf, checkHeaderAnnotations, paramHeaders, toOutput, toolLister } from './tools.js'
