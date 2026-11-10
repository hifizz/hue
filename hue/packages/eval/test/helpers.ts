import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HueEvent, SandboxPort, Usage } from '@hue/core'
import type { EvalSandbox } from '../src/index.js'

/** 在宿主上跑命令的假执行环境：只给测试用，真正的隔离是 @hue/sandbox 的事。 */
export function hostSandbox(dir: string, log: string[] = []): EvalSandbox {
  const sb: SandboxPort & { dispose(): Promise<void> } = {
    specVersion: 'hue.sandbox.v1', id: 'host',
    exec: (cmd, o) => new Promise(res => {
      execFile('sh', ['-c', cmd], { cwd: dir, timeout: o.timeoutMs ?? 20_000 }, (err, stdout, stderr) => {
        const code = (err as { code?: number | string } | null)?.code
        res({ exitCode: err ? (typeof code === 'number' ? code : 1) : 0, stdout, stderr, timedOut: !!(err as { killed?: boolean } | null)?.killed })
      })
    }),
    readFile: async p => new Uint8Array(await readFile(join(dir, p))),
    writeFile: async (p, d) => { await writeFile(join(dir, p), d) },
    list: async p => (await readdir(join(dir, p), { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' as const : 'file' as const })),
    dispose: async () => { log.push('dispose') },
  }
  return sb
}

let seq = 0
const env = (at: number) => ({ v: 1 as const, id: `e${++seq}`, sessionId: 's', seq: seq, at })
const usage = (i: number, o: number, cr = 0): Usage => ({ inputTokens: i, outputTokens: o, ...(cr && { cacheReadTokens: cr }) })

export const ev = {
  turn: (): HueEvent => ({ ...env(0), type: 'turn.started', turnId: 't' }),
  model: (text: string, u: Usage = usage(10, 5), finish: 'stop' | 'tool-calls' | 'aborted' = 'stop'): HueEvent =>
    ({ ...env(0), type: 'model.message', message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [] }, modelId: 'm', finishReason: finish, usage: u, durationMs: 1 }),
  call: (callId: string, name = 'bash', input: object = {}): HueEvent => ({ ...env(0), type: 'tool.call', callId, name, input: input as never, effects: 'unsafe' }),
  result: (callId: string, text = 'ok', isError = false, synthetic?: 'denied'): HueEvent =>
    ({ ...env(0), type: 'tool.result', callId, name: 'bash', content: [{ type: 'text', text }], isError, durationMs: 1, ...(synthetic && { synthetic }) }),
  end: (reason: 'stop' | 'stop_condition' | 'interrupted' | 'error' | 'length', error?: { code: 'model_error' | 'context_overflow'; message: string }): HueEvent =>
    ({ ...env(0), type: 'turn.ended', turnId: 't', reason, usage: usage(0, 0), steps: 1, ...(error && { error }) }),
  compacted: (): HueEvent => ({ ...env(0), type: 'context.compacted', compaction: { strategy: 'x', throughIndex: 1, replacement: [], tokensBefore: 2, tokensAfter: 1 } }),
  usage,
}
