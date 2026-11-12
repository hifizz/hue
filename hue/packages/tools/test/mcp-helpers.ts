import type { InputResponse, Tool, ToolContext } from '@hue/core'
import { mcp } from '../src/mcp/index.js'
import type { McpOptions, McpServer } from '../src/mcp/index.js'
import type { RpcMessage } from '../src/mcp/transport.js'
import type { MockOptions } from './mcp-mock.js'

export const SERVER = new URL('./mcp-stdio-server.ts', import.meta.url).pathname
export const TSX = import.meta.resolve('tsx')

/**
 * received() 读的是子进程的 stderr，而工具结果走 stdout，两条管道各自独立：结果先到、对应的 recv: 行还没读到是可能的
 * （GitHub Actions 的 Linux runner 上出现过：断言"收到 2 次 tools/call"时只看到 1 次）。
 * settled() 等 stderr 连续 quietMs 没有新行再返回，断言前先 await 它。
 */
export interface Spawned { server: McpServer; stderr: string[]; received: () => RpcMessage[]; settled: (quietMs?: number) => Promise<void>; pid: () => Promise<number> }

/** 起一个 mock stdio server，并把它 stderr 里记的"收到了什么"解析出来。 */
export function stdio(mock: MockOptions = {}, o: Partial<McpOptions> = {}): Spawned {
  const stderr: string[] = []
  const server = mcp.stdio(process.execPath, ['--import', TSX, SERVER, JSON.stringify(mock)], { name: 'mock', ...o, onStderr: l => stderr.push(l) })
  return {
    server, stderr,
    received: () => stderr.filter(l => l.startsWith('recv:')).map(l => JSON.parse(l.slice(5)) as RpcMessage),
    settled: async (quietMs = 100) => {
      for (let seen = -1; seen !== stderr.length;) { seen = stderr.length; await new Promise(r => setTimeout(r, quietMs)) }
    },
    pid: async () => { await until(() => stderr.some(l => l.startsWith('pid:'))); return Number(stderr.findLast(l => l.startsWith('pid:'))!.slice(4)) },
  }
}

export const ctxOf = (over: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal, sessionId: 's', turnId: 't', callId: 'c', progress: () => {}, requestInput: async () => ({ action: 'cancel' }), ...over,
})

const capCtx = { sessionId: 's', turnId: 't', input: { role: 'user' as const, content: [] }, signal: new AbortController().signal }
export const toolsOf = async (s: McpServer): Promise<Record<string, Tool>> => Object.fromEntries((await s.tools!(capCtx)).map(t => [t.name, t]))
export const text = (out: { content: Array<{ type: string; text?: string }> }) => out.content.map(c => c.text ?? `[${c.type}]`).join('\n')
export const run = async (t: Tool, input: object, ctx: ToolContext = ctxOf()) => t.execute((t.parse ? t.parse(input as never) : input) as never, ctx)
export const answerWith = (r: InputResponse) => async () => r
export const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
export const until = async (f: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 20)) } }
export const capabilityCtx = capCtx
