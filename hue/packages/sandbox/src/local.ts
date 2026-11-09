import { spawn } from 'node:child_process'
import type { SandboxPort } from '@hue/core'
import { collect } from './exec.js'
import { fileOps } from './fs.js'

export interface LocalOptions {
  root: string
  /** 默认 false：路径（含符号链接）必须落在 root 内。true 时不检查，只用来跑信得过的东西。 */
  allowOutsideRoot?: boolean
  /** 每次 exec 都带上的环境变量（在最小集合之上）。 */
  env?: Record<string, string>
}

/**
 * 本地进程。隔离只有两层：路径锁（文件接口）和环境变量白名单；命令本身仍以你的用户身份运行，
 * 能读写 root 之外的任何地方（`cd /` 就出去了）。要真正隔离用 docker()。
 */
export async function local(o: LocalOptions): Promise<SandboxPort> {
  const fsOps = await fileOps(o.root, o.root, 'sandbox:local', o.allowOutsideRoot)
  const root = await fsOps.hostPath('.')
  return {
    specVersion: 'hue.sandbox.v1',
    id: `local:${root}`,
    readFile: fsOps.readFile, writeFile: fsOps.writeFile, list: fsOps.list,
    async exec(cmd, e) {
      e.signal?.throwIfAborted()
      const cwd = await fsOps.hostPath(e.cwd ?? '.')
      // 不继承宿主环境：ANTHROPIC_API_KEY 之类不能被模型执行的命令读到。只给最小集合 + 显式传入的。
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? root, LANG: process.env.LANG ?? 'en_US.UTF-8', ...o.env, ...e.env }
      const child = spawn('/bin/sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) // detached = 自成进程组
      const killTree = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 已经退出 */ } }
      return collect(child, killTree, e)
    },
  }
}
