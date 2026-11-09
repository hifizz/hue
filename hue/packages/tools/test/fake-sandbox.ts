// 内存版 sandbox：工具测试用，不放 src。exec 由测试按需脚本化。
import type { ExecOptions, ExecResult, SandboxPort, ToolContext } from '@hue/core'
import { fakeCtx } from '@hue/core/contracts'

export interface FakeSandbox extends SandboxPort { files: Map<string, Uint8Array>; execs: Array<{ cmd: string; opts: ExecOptions }>; text(path: string): string }
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { ignoreBOM: true }) // 保留 BOM，测试才能看出工具有没有弄丢它
export const ok = (stdout = '', stderr = '', exitCode = 0, timedOut = false): ExecResult => ({ exitCode, stdout, stderr, timedOut })

export function fakeSandbox(files: Record<string, string | Uint8Array> = {}, exec?: (cmd: string, opts: ExecOptions) => ExecResult | Promise<ExecResult>): FakeSandbox {
  const fs = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]))
  const execs: FakeSandbox['execs'] = []
  return {
    specVersion: 'hue.sandbox.v1', id: 'fake', files: fs, execs,
    text: p => dec.decode(fs.get(p)),
    async exec(cmd, opts) { execs.push({ cmd, opts }); return exec ? exec(cmd, opts) : ok() },
    async readFile(p) { const f = fs.get(p); if (!f) throw new Error(`ENOENT: no such file: ${p}`); return f },
    async writeFile(p, d) { fs.set(p, typeof d === 'string' ? enc.encode(d) : d) },
    async list(p) {
      const prefix = p === '.' ? '' : `${p.replace(/\/$/, '')}/`
      const seen = new Map<string, 'file' | 'dir'>()
      for (const k of fs.keys()) if (k.startsWith(prefix)) { const rest = k.slice(prefix.length), i = rest.indexOf('/'); seen.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir') }
      return [...seen].map(([name, type]) => ({ name, type }))
    },
  }
}
export const ctxWith = (sandbox?: SandboxPort, over: Partial<ToolContext> = {}): ToolContext => fakeCtx({ sandbox, ...over })
