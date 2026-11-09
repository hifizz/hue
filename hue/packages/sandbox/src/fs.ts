import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { HueFault } from '@hue/core'
import type { SandboxPort } from '@hue/core'

export type FileOps = Pick<SandboxPort, 'readFile' | 'writeFile' | 'list'> & {
  /** 沙箱里的路径 → 宿主上的真实路径（已检查不越界）。 */
  hostPath(p: string): Promise<string>
  /** 宿主上的真实路径 → 沙箱里看到的路径（exec 的 cwd 要用）。 */
  sandboxPath(hostPath: string): string
}

/**
 * 文件操作，local 和 docker 共用：docker 只挂载一个目录，所以读写文件直接走宿主上的挂载目录，
 * 不必每次 docker exec cat。路径检查也因此只写一份。
 *
 * virtualRoot 是沙箱里"根目录"的名字：local 就是 root 本身，docker 是容器里的挂载点（/work）。
 * 模型在 pwd / 报错里看到的是 virtualRoot 下的路径，它给回来的绝对路径也是，所以两边都要认。
 */
export async function fileOps(rootDir: string, virtualRoot: string, name: string, allowOutsideRoot = false): Promise<FileOps> {
  // macOS 的 /tmp、/var 是符号链接：不解析的话，"在 root 内"的判断会被符号链接骗过去。
  const root = await realpath(rootDir)
  const inside = (p: string) => p === root || p.startsWith(root + sep)
  const escape = (p: string) => new HueFault({ code: 'policy_denied', message: `path escapes the sandbox root: ${p}`, source: name })

  async function hostPath(p: string): Promise<string> {
    const abs = isAbsolute(p) && (p === virtualRoot || p.startsWith(virtualRoot + sep)) ? root + p.slice(virtualRoot.length) : resolve(root, p)
    if (allowOutsideRoot) return abs
    if (!inside(abs)) throw escape(p)
    // 文件可能还不存在（write），所以对最近的已存在祖先做 realpath：挡住"root 里有个链接指到外面"。
    // 检查和使用之间有时间差（TOCTOU）：并发的恶意进程可以在检查后换链接。威胁模型是\"模型写错路径\"，不是对抗性并发。
    for (let probe = abs; ;) {
      try { if (!inside(await realpath(probe))) throw escape(p); break } catch (e) {
        if (e instanceof HueFault) throw e
        const up = dirname(probe); if (up === probe) break; probe = up
      }
    }
    return abs
  }

  return {
    hostPath,
    sandboxPath: h => (h === root || h.startsWith(root + sep) ? virtualRoot + h.slice(root.length) : h),
    readFile: async (p, signal) => { signal?.throwIfAborted(); return new Uint8Array(await readFile(await hostPath(p), { signal })) },
    writeFile: async (p, d, signal) => { signal?.throwIfAborted(); const f = await hostPath(p); await mkdir(dirname(f), { recursive: true }); await writeFile(f, d, { signal }) },
    list: async (p, signal) => { signal?.throwIfAborted(); return (await readdir(await hostPath(p), { withFileTypes: true })).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' as const : 'file' as const })) },
  }
}
