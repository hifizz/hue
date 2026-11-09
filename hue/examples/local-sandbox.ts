/**
 * 临时的本地 sandbox，给里程碑脚本用，等 @hue/sandbox 落地后删掉。
 * 只做三件最要紧的事：路径锁在 root 内（含符号链接）、exec 不继承宿主 env（否则 API key 会被 bash 读到）、
 * 超时杀整个进程组。没有 Docker 隔离，命令仍然以你的用户身份运行。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { HueFault } from '@hue/core'
import type { SandboxPort } from '@hue/core'

const MAX_CAPTURE = 1_000_000 // 每个流最多收集 1MB，防止内存爆掉
const abortError = () => new DOMException('Aborted', 'AbortError')

export async function localSandbox(rootDir: string): Promise<SandboxPort> {
  const root = await realpath(rootDir)
  const lexRoot = resolve(rootDir) // macOS 的 /tmp、/var 是符号链接：调用方可能用没解析过的绝对路径指向 root 内部
  const inside = (p: string) => p === root || p.startsWith(root + sep)
  const escape = (p: string) => new HueFault({ code: 'policy_denied', message: `path escapes the sandbox root: ${p}`, source: 'sandbox:local' })

  /** 解析到 root 内。文件可能还不存在（write），所以对最近的已存在祖先做 realpath，挡住符号链接逃逸。 */
  async function safe(p: string): Promise<string> {
    let abs = resolve(root, p)
    if (abs === lexRoot || abs.startsWith(lexRoot + sep)) abs = root + abs.slice(lexRoot.length)
    if (!inside(abs)) throw escape(p)
    let probe = abs
    while (true) {
      try { if (!inside(await realpath(probe))) throw escape(p); break } catch (e) {
        if (e instanceof HueFault) throw e
        const up = dirname(probe); if (up === probe) break; probe = up
      }
    }
    return abs
  }

  return {
    specVersion: 'hue.sandbox.v1', id: `local:${root}`,
    readFile: async (p, signal) => { signal?.throwIfAborted(); return new Uint8Array(await readFile(await safe(p), { signal })) },
    writeFile: async (p, d, signal) => { signal?.throwIfAborted(); const f = await safe(p); await mkdir(dirname(f), { recursive: true }); await writeFile(f, d, { signal }) },
    list: async (p, signal) => { signal?.throwIfAborted(); return (await readdir(await safe(p), { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' as const : 'file' as const })) },
    async exec(cmd, o) {
      o.signal?.throwIfAborted()
      const cwd = await safe(o.cwd ?? '.')
      // 只给最小环境 + 调用方显式传的。宿主的 ANTHROPIC_API_KEY / AI_GATEWAY_API_KEY 不会出现在命令里。
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? root, LANG: 'en_US.UTF-8', ...o.env }
      return new Promise((resolveExec, reject) => {
        const child = spawn('/bin/sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) // detached = 自成进程组
        let stdout = '', stderr = '', timedOut = false, aborted = false
        const killGroup = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 已经退出 */ } }
        const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; killGroup() }, o.timeoutMs) : undefined
        const onAbort = () => { aborted = true; killGroup() }
        o.signal?.addEventListener('abort', onAbort, { once: true })
        const take = (acc: string, d: Buffer) => acc.length < MAX_CAPTURE ? acc + d.toString('utf8') : acc
        child.stdout.on('data', d => { stdout = take(stdout, d) })
        child.stderr.on('data', d => { stderr = take(stderr, d) })
        child.stdin.on('error', () => {}) // 命令不读 stdin 就退出时会 EPIPE，无所谓
        child.stdin.end(o.stdin ?? '')
        child.on('error', reject)
        child.on('close', code => {
          clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort)
          if (aborted) return reject(abortError())
          resolveExec({ exitCode: code ?? 137, stdout, stderr, timedOut })
        })
      })
    },
  }
}
