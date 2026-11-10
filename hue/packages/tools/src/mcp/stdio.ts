import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { abortError, TransportError } from './transport.js'
import type { Reply, RequestOptions, RpcMessage, Transport } from './transport.js'

export interface StdioOptions {
  env?: Record<string, string>
  cwd?: string
  /** server 的 stderr 是日志，不是错误；默认丢弃。 */
  onStderr?: (line: string) => void
}

interface Pending { resolve(r: Reply): void; reject(e: Error): void; onNotification?: (n: RpcMessage) => void }

/** 子进程 + 一行一条 JSON-RPC。第一次请求时才拉起；意外退出后下一次请求重新拉起（协议无状态，丢掉的请求由上层决定是否重发）。 */
export function stdioTransport(command: string, args: string[], o: StdioOptions = {}): Transport {
  let child: ChildProcess | undefined
  const pending = new Map<number | string, Pending>()
  const killOnExit = () => child?.kill('SIGKILL')
  process.on('exit', killOnExit)

  const send = (msg: RpcMessage) => { child?.stdin?.write(`${JSON.stringify(msg)}\n`) }

  function start(): ChildProcess {
    const c = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...o.env }, cwd: o.cwd })
    child = c
    // 子进程退出后继续写 stdin 会抛 EPIPE；请求会在 exit 里统一失败。
    c.stdin!.on('error', () => {})
    createInterface({ input: c.stdout! }).on('line', line => onLine(c, line))
    createInterface({ input: c.stderr! }).on('line', l => o.onStderr?.(l))
    const gone = (why: string) => {
      if (child !== c) return
      child = undefined
      for (const p of pending.values()) p.reject(new TransportError(why))
      pending.clear()
      transport.onRestart?.()
    }
    c.on('error', e => gone(`could not start "${command}": ${e.message}`))
    c.on('exit', (code, sig) => gone(`server exited (${sig ?? code})`))
    return c
  }

  function onLine(c: ChildProcess, line: string) {
    let m: RpcMessage
    try { m = JSON.parse(line) } catch { return }
    if (m.method && m.id !== undefined) {
      // server 主动发请求是旧协议的做法；我们没声明任何能力，一律拒绝，免得它一直等。
      if (child === c) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'This client does not handle server-initiated requests' } })
    } else if (m.method) {
      const token = (m.params as { progressToken?: number | string } | undefined)?.progressToken
      if (token !== undefined) pending.get(token)?.onNotification?.(m)
    } else if (m.id !== undefined) {
      const p = pending.get(m.id)
      if (p) { pending.delete(m.id); p.resolve({ message: m }) }
    }
  }

  const transport: Transport = {
    kind: 'stdio',
    request(msg, ro: RequestOptions) {
      if (ro.signal.aborted) return Promise.reject(abortError())
      return new Promise<Reply>((resolve, reject) => {
        const id = msg.id!
        const done = () => { pending.delete(id); ro.signal.removeEventListener('abort', onAbort) }
        const onAbort = () => {
          done()
          // stdio 没有每个请求一条的流可以关，取消只能发通知。
          send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled by client' } })
          reject(abortError())
        }
        pending.set(id, { resolve: r => { done(); resolve(r) }, reject: e => { done(); reject(e) }, onNotification: ro.onNotification })
        ro.signal.addEventListener('abort', onAbort, { once: true })
        if (!child) start()
        send(msg)
      })
    },
    async notify(msg) { if (!child) start(); send(msg) },
    async close() {
      process.off('exit', killOnExit)
      const c = child
      if (!c) return
      child = undefined
      for (const p of pending.values()) p.reject(new TransportError('transport closed'))
      pending.clear()
      const exited = new Promise<void>(r => c.once('exit', () => r()))
      // 规范的关闭顺序：关 stdin，等它自己退出，不退再 SIGTERM，最后 SIGKILL。
      c.stdin?.end()
      for (const [sig, wait] of [[undefined, 1500], ['SIGTERM', 1500], ['SIGKILL', 3000]] as const) {
        if (sig) c.kill(sig)
        if (await Promise.race([exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), wait).unref())])) return
      }
    },
  }
  return transport
}
