// 真 shell 的最小 sandbox：只用来验证 glob / grep 拼出的命令真的能跑（包括没有 rg 时的回退分支）。
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxPort } from '@hue/core'

export function localSandbox(env: Record<string, string> = {}): SandboxPort {
  return {
    specVersion: 'hue.sandbox.v1', id: 'local-test',
    exec: (cmd, o) => new Promise((resolve, reject) => {
      execFile('/bin/sh', ['-c', cmd], { cwd: o.cwd, env: { ...process.env, ...env }, signal: o.signal, timeout: o.timeoutMs ?? 10_000 }, (err: any, stdout, stderr) => {
        if (err?.name === 'AbortError') return reject(err)
        resolve({ exitCode: typeof err?.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr, timedOut: !!err?.killed })
      })
    }),
    readFile: async p => new Uint8Array(await readFile(p)),
    writeFile: async (p, d) => writeFile(p, d),
    list: async p => (await readdir(p, { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' as const : 'file' as const })),
  }
}

/** PATH 里只有 sh 需要的几个基础命令、没有 rg：让 `command -v rg` 失败，走 find / grep 回退。 */
export function pathWithoutRg(): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'hue-bin-')), 'bin'); mkdirSync(bin)
  for (const n of ['grep', 'find', 'sort', 'sed']) symlinkSync(execFileSync('/usr/bin/env', ['which', n]).toString().trim(), join(bin, n))
  return bin
}
