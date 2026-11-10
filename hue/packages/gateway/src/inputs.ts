import type { InputPort, InputResponse } from '@hue/core'

/**
 * 把 agent 的"需要人输入"变成"等 HTTP 回答"。请求本身由 loop 以 input.requested 事件发出（客户端从事件流里看到），
 * 这里只负责把请求挂起，直到有人 POST 答案、超时或会话被打断。
 */
export function createInputs(timeoutMs: number) {
  const pending = new Map<string, { sessionId: string; settle: (r: InputResponse) => void }>()
  const port: InputPort = {
    request: (req, signal) => new Promise<InputResponse>(resolve => {
      let timer: NodeJS.Timeout | undefined
      const settle = (r: InputResponse) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); pending.delete(req.requestId); resolve(r) }
      const onAbort = () => settle({ action: 'cancel' })
      if (signal.aborted) return resolve({ action: 'cancel' })
      timer = setTimeout(() => settle({ action: 'cancel' }), timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      pending.set(req.requestId, { sessionId: req.sessionId, settle })
    }),
  }
  return {
    port,
    /** requestId 必须属于这个会话，否则当作不存在（不能用 A 会话的路径去批准 B 会话的请求）。 */
    answer(sessionId: string, requestId: string, r: InputResponse): boolean {
      const p = pending.get(requestId)
      if (!p || p.sessionId !== sessionId) return false
      p.settle(r); return true
    },
    pendingFor: (sessionId: string) => [...pending].filter(([, p]) => p.sessionId === sessionId).map(([id]) => id),
    cancelAll() { for (const p of [...pending.values()]) p.settle({ action: 'cancel' }) },
  }
}
export type Inputs = ReturnType<typeof createInputs>
