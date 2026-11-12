import type { HueEvent } from '@hue/core'
import { checkAppend, parseRow } from './check.js'
import type { ListableStore, SessionInfo } from './types.js'

/**
 * 内存版：测试和一次性脚本用。存的是 JSON 字符串而不是对象引用，
 * 这样（1）读出来的事件是副本，改它不会改日志；（2）不能序列化的东西在这里就会暴露，和 sqlite 的行为一致。
 */
export function memoryStore(): ListableStore {
  const logs = new Map<string, string[]>()
  const last = (sid: string) => logs.get(sid)?.length ?? 0
  return {
    specVersion: 'hue.store.v1',
    async append(events: HueEvent[]) {
      checkAppend(events, last)
      const bodies = events.map(e => JSON.stringify(e))
      events.forEach((e, i) => { const l = logs.get(e.sessionId) ?? []; l.push(bodies[i]!); logs.set(e.sessionId, l) })
    },
    async *read(sessionId, opts) {
      const l = logs.get(sessionId) ?? []
      for (let i = Math.max(0, (opts?.fromSeq ?? 1) - 1); i < l.length; i++) yield parseRow(sessionId, i + 1, l[i]!)
    },
    async lastSeq(sessionId) { return last(sessionId) },
    async *sessions(): AsyncIterable<SessionInfo> {
      for (const [sessionId, l] of logs) yield info(sessionId, l.length, parseRow(sessionId, 1, l[0]!), parseRow(sessionId, l.length, l.at(-1)!))
    },
  }
}

export function info(sessionId: string, lastSeq: number, first: HueEvent, last: HueEvent): SessionInfo {
  return { sessionId, lastSeq, updatedAt: last.at, ...(first.type === 'session.created' && first.parent ? { parent: first.parent } : {}) }
}
