/** 测试用的 MCP server 行为。stdio（mcp-stdio-server.ts 子进程）和 HTTP（测试里起的 http server）共用同一份。 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RpcMessage } from '../src/mcp/transport.js'

export type Mode = 'modern' | 'legacy' | 'silent-legacy'
export interface MockOptions {
  mode?: Mode
  supported?: string[]
  /** 不带 resultType（模拟没按新规范写的 server） */
  noResultType?: boolean
  pages?: boolean
  instructions?: string
  /** 进程会被重新拉起，"只死一次"的记号要落在文件里。 */
  stateDir?: string
  /** stdin 关了也不退出（模拟不听话的 server），用来测强制终止。 */
  ignoreEof?: boolean
  /** 连 SIGTERM 也不理，只有 SIGKILL 能杀。 */
  ignoreTerm?: boolean
  /** 额外的工具；调用时回 `called <name> <参数>`。 */
  extra?: Array<Record<string, unknown> & { name: string }>
}
/** 一次请求要发出去的东西：先是若干通知，最后一条是响应；或者让传输层执行一个动作。 */
export type Out = { type: 'send'; message: RpcMessage } | { type: 'die' } | { type: 'none' } | { type: 'request'; message: RpcMessage; then: RpcMessage['id'] }

const NS = 'io.modelcontextprotocol/'
export const tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write', description: 'Write something somewhere', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'idem', description: 'Idempotent update', inputSchema: { type: 'object', properties: {} }, annotations: { idempotentHint: true } },
  { name: 'ask', description: 'Ask the user for a name', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'ask2', description: 'Needs two rounds of input', inputSchema: { type: 'object', properties: {} } },
  { name: 'loop', description: 'Never satisfied', inputSchema: { type: 'object', properties: {} } },
  { name: 'sample', description: 'Asks for sampling', inputSchema: { type: 'object', properties: {} } },
  { name: 'progress', description: 'Reports progress', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'hang', description: 'Never answers', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'die-once', description: 'Connection dies the first time', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'die-once-unsafe', description: 'Connection dies the first time', inputSchema: { type: 'object', properties: {} } },
  { name: 'rich', description: 'Returns many kinds of content', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Reports a tool error', inputSchema: { type: 'object', properties: {} } },
  { name: 'rpc-fail', description: 'Fails with a protocol error', inputSchema: { type: 'object', properties: {} } },
  { name: 'srv-request', description: 'Legacy-style: sends a request to the client mid-call', inputSchema: { type: 'object', properties: {} } },
  { name: 'dotted.name', description: 'Name with a dot in it', inputSchema: { type: 'object', properties: {} } },
]

export function createMock(o: MockOptions = {}) {
  const mode = o.mode ?? 'modern'
  const supported = o.supported ?? ['2026-07-28']
  const dead = { has: (n: string) => (o.stateDir ? existsSync(join(o.stateDir, n)) : set.has(n)), add: (n: string) => (o.stateDir ? writeFileSync(join(o.stateDir, n), '') : void set.add(n)) }
  const set = new Set<string>()
  let initialized = false
  const log: RpcMessage[] = []

  const ok = (id: RpcMessage['id'], result: Record<string, unknown>): Out => ({ type: 'send', message: { jsonrpc: '2.0', id, result: o.noResultType || mode !== 'modern' ? result : { resultType: 'complete', ...result } } })
  const fail = (id: RpcMessage['id'], code: number, message: string, data?: unknown): Out[] => [{ type: 'send', message: { jsonrpc: '2.0', id, error: { code, message, data } } }]
  const text = (t: string) => ({ content: [{ type: 'text', text: t }] })

  function handle(msg: RpcMessage): Out[] {
    log.push(msg)
    const { id, method = '' } = msg
    const params = (msg.params ?? {}) as Record<string, any>
    if (id === undefined) { if (method === 'notifications/initialized') initialized = true; return [{ type: 'none' }] }

    if (mode !== 'modern') {
      if (method === 'initialize') return [ok(id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'legacy-mock', version: '1' }, ...(o.instructions && { instructions: o.instructions }) })]
      if (!initialized && mode === 'silent-legacy') return [{ type: 'none' }]
      if (!initialized) return fail(id, method === 'server/discover' ? -32601 : -32600, method === 'server/discover' ? 'Method not found' : 'Server not initialized')
    } else {
      const meta = (params._meta ?? {}) as Record<string, any>
      const version = meta[`${NS}protocolVersion`]
      if (!version || !meta[`${NS}clientCapabilities`] || !meta[`${NS}clientInfo`]) return fail(id, -32602, 'missing required _meta fields')
      if (!supported.includes(version)) return fail(id, -32022, 'Unsupported protocol version', { supported, requested: version })
      if (method === 'server/discover') return [ok(id, { supportedVersions: supported, capabilities: { tools: {} }, _meta: { [`${NS}serverInfo`]: { name: 'mock', version: '1' } }, ...(o.instructions && { instructions: o.instructions }), ttlMs: 1000, cacheScope: 'public' })]
    }

    if (method === 'tools/list') {
      const base = [...tools, ...(o.extra ?? [])]
      const all = o.pages ? (params.cursor ? base.slice(8) : base.slice(0, 8)) : base
      return [ok(id, { tools: all, ...(o.pages && !params.cursor && { nextCursor: 'page2' }), ttlMs: 60_000, cacheScope: 'public' })]
    }
    if (method !== 'tools/call') return fail(id, -32601, 'Method not found')

    const args = (params.arguments ?? {}) as Record<string, any>
    const token = params._meta?.progressToken
    const elicit = (key: string, message: string) => ({ [key]: { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } })
    const need = (inputRequests: Record<string, unknown>, requestState?: string): Out[] => [ok(id, { resultType: 'input_required', inputRequests, ...(requestState && { requestState }) })]
    switch (params.name) {
      case 'echo': return [ok(id, { ...text(`echo:${args.text}`), structuredContent: { text: args.text } })]
      case 'write': return [ok(id, text('wrote'))]
      case 'idem': return [ok(id, text('updated'))]
      case 'ask': {
        const name = params.inputResponses?.who?.content?.name
        if (params.inputResponses?.who?.action === 'decline') return [ok(id, text('user declined'))]
        return name && params.requestState === 'S1' ? [ok(id, text(`hello ${name}`))] : need(elicit('who', 'Who are you?'), 'S1')
      }
      case 'ask2':
        if (params.requestState === 'S2') return [ok(id, text(`got ${params.inputResponses?.second?.content?.name} after ${params.inputResponses?.first ? 'leak' : 'clean'}`))]
        return params.requestState === 'S1' ? need(elicit('second', 'And the second?'), 'S2') : need(elicit('first', 'First?'), 'S1')
      case 'loop': return need(elicit('again', 'Again?'), 'L')
      case 'sample': return need({ s: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } } })
      case 'progress': return [{ type: 'send', message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'half' } } }, ok(id, text('done'))]
      case 'hang': return [{ type: 'none' }]
      case 'die-once': case 'die-once-unsafe':
        if (!dead.has(params.name)) { dead.add(params.name); return [{ type: 'die' }] }
        return [ok(id, text(`survived ${params.name}`))]
      case 'rich': return [ok(id, { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }, { type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' }, { type: 'resource', resource: { uri: 'file:///b.txt', text: 'bee' } }, { type: 'resource', resource: { uri: 'file:///c.bin', blob: 'AA==', mimeType: 'application/octet-stream' } }] })]
      case 'fail': return [ok(id, { content: [{ type: 'text', text: 'it broke' }], isError: true })]
      case 'rpc-fail': return fail(id, -32602, 'Unknown tool: nope')
      case 'srv-request': return [{ type: 'request', message: { jsonrpc: '2.0', id: 'srv1', method: 'elicitation/create', params: { message: 'hello?' } }, then: id }]
      case 'dotted.name': return [ok(id, text('dotted'))]
      default: return o.extra?.some(x => x.name === params.name) ? [ok(id, text(`called ${params.name} ${JSON.stringify(args)}`))] : fail(id, -32602, `Unknown tool: ${params.name}`)
    }
  }
  return { handle, log }
}
