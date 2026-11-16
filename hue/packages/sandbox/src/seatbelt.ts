import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { HueFault } from '@hue/core'
import type { SandboxPort } from '@hue/core'
import { collect } from './exec.js'
import { fileOps } from './fs.js'

export interface SeatbeltOptions {
  /** 真实目录（不复制），命令和文件接口都在它里面。 */
  root: string
  /** 默认 false：路径（含符号链接）必须落在 root 内。true 时不检查文件接口（OS 门禁仍在）。 */
  allowOutsideRoot?: boolean
  /** 每次 exec 都带上的环境变量（在最小集合之上）。 */
  env?: Record<string, string>
  /** 写额外放开的宿主目录（真实路径，会用 realpath 解析）。root 永远可写。 */
  allowWrite?: string[]
  /** 读额外拒绝的宿主路径（同上解析）。默认拒绝 ~/.ssh、~/.aws、~/.gnupg（存在的才加）。 */
  denyRead?: string[]
  /** 网络放行的域名（如 registry.npmjs.org）。默认 [] = 全禁（实测 curl 直接连不上）。 */
  allowedDomains?: string[]
  /** 允许命令绑本地端口（起 dev server 要开）。默认 false。 */
  allowLocalBinding?: boolean
}

const SECRET_DIRS = ['.ssh', '.aws', '.gnupg']

/**
 * macOS Seatbelt 沙箱（Linux 走 bubblewrap，未验证）：真实目录 + 操作系统门禁。
 * 文件读默认允许、写默认拒绝（root 永远可写）；网络默认全断，按域名放行。
 * 和 local 的差别是 bash 也出不去；和 docker 的差别是没有副本、不重装依赖。
 * 验证记录：docs/research/sandbox-evidence.md §6.1。环境变量白名单和 local 一样（srt 不管 env）。
 */
export async function seatbelt(o: SeatbeltOptions): Promise<SandboxPort> {
  const fsOps = await fileOps(o.root, o.root, 'sandbox:seatbelt', o.allowOutsideRoot)
  const root = await fsOps.hostPath('.')

  const denyRead = [...SECRET_DIRS.map(d => join(homedir(), d)), ...(o.denyRead ?? [])]
    .flatMap(p => { try { return [realpathSync(p)] } catch { return [] } }) // 不存在的路径 srt 在 Linux 会静默跳过，这里先滤掉

  // 全局单例。两个 seatbelt() 实例并存时配置必须一样，否则 throw（core 冻结，没有 dispose 端口，靠进程结束 reset）。
  const key = JSON.stringify({ root, denyRead, allowWrite: o.allowWrite, allowedDomains: o.allowedDomains })
  if (initialized && initialized.key !== key) {
    throw new HueFault({ code: 'internal', message: 'seatbelt: 一个进程只能有一份 seatbelt 配置（SandboxManager 是全局单例）', source: 'sandbox:seatbelt' })
  }
  if (!initialized) {
    await SandboxManager.initialize({
      network: { allowedDomains: o.allowedDomains ?? [], deniedDomains: [], ...(o.allowLocalBinding ? { allowLocalBinding: true } : {}) },
      filesystem: { denyRead, allowWrite: [root, ...(o.allowWrite ?? []).map(p => realpathSync(p))], denyWrite: [] },
    })
    initialized = { key }
  }

  return {
    specVersion: 'hue.sandbox.v1',
    id: `seatbelt:${root}`,
    readFile: fsOps.readFile, writeFile: fsOps.writeFile, list: fsOps.list,
    async exec(cmd, e) {
      e.signal?.throwIfAborted()
      const cwd = await fsOps.hostPath(e.cwd ?? '.')
      const { argv, env: srtEnv } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, e.signal, cwd)
      // srt 返回的 env 是完整 process.env（密钥会原样泄给命令），所以只取它自己加的键，叠在 local 同款白名单上。
      const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? root, LANG: process.env.LANG ?? 'en_US.UTF-8',
        ...pickOwn(srtEnv), ...o.env, ...e.env,
      }
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      // 不能像 local 那样杀进程组：wrap 后的命令会置 sandbox-exec，detached 让 seatbelt 规则失效（srt 自己的 spawn 也不 detached）。
      // 超时/取消只 SIGKILL 直接子进程；它 fork 出的后台进程可能残留，这是和 local 相比的一个已知的弱。
      const killTree = () => { try { child.kill('SIGKILL') } catch { /* 已经退出 */ } }
      return collect(child, killTree, e)
    },
  }
}

let initialized: { key: string } | undefined

// srt 往 env 里加的键（SANDBOX_RUNTIME、代理地址、凭证掩码等）：在 srtEnv 里、但和 process.env 里的值不一样的，
// 以及 process.env 里没有的。这样密钥不会漏，srt 自己的工作变量不丢。
function pickOwn(srtEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(srtEnv)) if (v !== undefined && process.env[k] !== v) out[k] = v
  return out
}
