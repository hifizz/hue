import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { HueFault } from '@hue/core'
import type { SandboxPort } from '@hue/core'
import { collect } from './exec.js'
import { fileOps } from './fs.js'

export interface DockerOptions {
  /** 默认 node:22。 */
  image?: string
  /** 宿主上要挂载的目录；容器里是 /work。只有它对容器可见。 */
  mount: string
  /** 默认 'bridge'（能联网，npm install 要用）。'none' = 完全断网。见 DECISIONS.md 第 2 条。 */
  network?: string
  memory?: string
  cpus?: number
  pidsLimit?: number
  /** 容器最长存活秒数，默认 4 小时。进程崩溃没来得及 dispose 时，容器靠它自己退出，不会永远留着。 */
  ttlSeconds?: number
  /** docker 可执行文件，默认 'docker'。 */
  bin?: string
}

export interface DockerSandbox extends SandboxPort {
  readonly containerName: string
  /** 删除容器。可以重复调用。 */
  dispose(): Promise<void>
}

export const WORKDIR = '/work'

// 按环境变量里的标记找进程再杀。不能只杀 `docker exec` 这个客户端进程：容器里的命令不会因此退出。
// 也不用进程组：后台命令（`cmd &`）可能换过组。标记在 env 里，子孙进程都继承。扫两遍应对杀的过程中又 fork 的。
const KILL_BY_MARK = 'for i in 1 2; do for p in /proc/[0-9]*; do if tr "\\0" "\\n" < $p/environ 2>/dev/null | grep -qx "HUE_EXEC_ID=$1"; then kill -9 ${p#/proc/} 2>/dev/null; fi; done; done'

export async function docker(o: DockerOptions): Promise<DockerSandbox> {
  const bin = o.bin ?? 'docker'
  const name = `hue-sb-${randomBytes(4).toString('hex')}`
  const fsOps = await fileOps(o.mount, WORKDIR, 'sandbox:docker')
  const host = await fsOps.hostPath('.')

  const cli = (args: string[], signal?: AbortSignal) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let stdout = '', stderr = ''
    c.stdout.on('data', d => { stdout += d }); c.stderr.on('data', d => { stderr += d })
    c.on('error', e => reject(e.name === 'AbortError' ? e : new HueFault({ code: 'internal', message: `cannot run "${bin}": ${e.message}. Is Docker installed?`, source: 'sandbox:docker' })))
    c.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
  })

  let started: Promise<void> | undefined
  let disposed = false
  const start = async (signal?: AbortSignal) => {
    const uid = process.getuid?.(), gid = process.getgid?.()
    const r = await cli(['run', '-d', '--rm', '--init', '--name', name, '--label', 'hue.sandbox=1',
      '--network', o.network ?? 'bridge', '--memory', o.memory ?? '2g', '--cpus', String(o.cpus ?? 2), '--pids-limit', String(o.pidsLimit ?? 1024),
      // 用宿主的 uid 运行：既不是 root，又能写挂载进来的目录（文件归属也对）。
      ...(uid === undefined ? [] : ['--user', `${uid}:${gid}`]),
      '-e', 'HOME=/tmp', '-e', 'LANG=C.UTF-8',
      '-v', `${host}:${WORKDIR}`, '-w', WORKDIR, o.image ?? 'node:22', 'sleep', String(o.ttlSeconds ?? 14_400)], signal)
    if (r.code !== 0) throw new HueFault({ code: 'internal', message: `docker run failed (is Docker/OrbStack running?): ${r.stderr.trim().slice(0, 500)}`, source: 'sandbox:docker' })
  }
  // 第一次用的时候才启动；启动失败要能重试（比如用户这时才去启动 Docker）。
  const ensure = (signal?: AbortSignal) => (started ??= start(signal).catch(e => { started = undefined; throw e }))

  return {
    specVersion: 'hue.sandbox.v1',
    id: `docker:${o.image ?? 'node:22'}:${name}`,
    containerName: name,
    readFile: fsOps.readFile, writeFile: fsOps.writeFile, list: fsOps.list,
    async exec(cmd, e) {
      e.signal?.throwIfAborted()
      if (disposed) throw new HueFault({ code: 'internal', message: 'sandbox has been disposed', source: 'sandbox:docker' })
      const cwd = fsOps.sandboxPath(await fsOps.hostPath(e.cwd ?? '.')) // 检查越界，并换成容器里的路径
      await ensure(e.signal)
      const mark = randomUUID()
      const env = Object.entries(e.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      const child = spawn(bin, ['exec', '-i', '-w', cwd, '-e', `HUE_EXEC_ID=${mark}`, ...env, name, 'sh', '-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] })
      const killTree = async () => {
        await cli(['exec', name, 'sh', '-c', KILL_BY_MARK, 'sh', mark]).catch(() => {})
        child.kill('SIGKILL') // 兜底：容器里没杀掉也要让 exec 返回
      }
      return collect(child, killTree, e)
    },
    async dispose() {
      disposed = true
      if (!started) return
      await cli(['rm', '-f', name]).catch(() => {})
    },
  }
}
