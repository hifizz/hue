import type { ChildProcess } from 'node:child_process'
import type { ExecOptions, ExecResult } from '@hue/core'

/** 每个流最多收集这么多字节。超过的部分继续读掉（否则子进程会因管道写满而卡住）但不保存。 */
export const MAX_CAPTURE = 1_000_000

export const abortError = () => new DOMException('Aborted', 'AbortError')

class Capture {
  private chunks: Buffer[] = []
  private bytes = 0
  private truncated = false
  add(d: Buffer) {
    const room = MAX_CAPTURE - this.bytes
    if (d.length > room) this.truncated = true
    if (room <= 0) return
    this.chunks.push(d.length > room ? d.subarray(0, room) : d)
    this.bytes += Math.min(d.length, room)
  }
  // 按字节收集、最后一起解码：每个包单独 toString 会把被切开的中文变成 �。
  text() { return Buffer.concat(this.chunks).toString('utf8') + (this.truncated ? `\n[output truncated at ${MAX_CAPTURE} bytes]\n` : '') }
}

/**
 * 等一个子进程结束，处理超时、取消、输出上限。local 和 docker 共用。
 * killTree 负责杀掉"整棵"进程：只杀 shell 不够，它的后台子进程还握着 stdout 管道，
 * 'close' 事件要等它们全死了才触发，exec 就会一直不返回。
 */
export function collect(child: ChildProcess, killTree: () => Promise<void> | void, o: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const out = new Capture(), err = new Capture()
    let timedOut = false, aborted = false
    const stop = () => { void Promise.resolve(killTree()).catch(() => {}) }
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; stop() }, o.timeoutMs) : undefined
    const onAbort = () => { aborted = true; stop() }
    const done = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort) }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout!.on('data', d => out.add(d))
    child.stderr!.on('data', d => err.add(d))
    child.stdin!.on('error', () => {}) // 命令不读 stdin 就退出时会 EPIPE，无所谓
    child.stdin!.end(o.stdin ?? '')
    child.on('error', e => { done(); reject(e) })
    child.on('close', code => {
      done()
      if (aborted) return reject(abortError())
      resolve({ exitCode: code ?? 137, stdout: out.text(), stderr: err.text(), timedOut })
    })
  })
}
