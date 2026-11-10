import type { HueEvent } from '@hue/core'

/** 每个会话一个内存里的订阅表。事件先由 runtime 落盘，再到这里：所以任何到过这里的 durable 事件，store 里都读得到。 */
export function createHub() {
  const subs = new Map<string, Set<(e: HueEvent) => void>>()
  return {
    publish(sessionId: string, e: HueEvent) { for (const f of [...(subs.get(sessionId) ?? [])]) f(e) },
    subscribe(sessionId: string, f: (e: HueEvent) => void): () => void {
      const set = subs.get(sessionId) ?? new Set()
      set.add(f); subs.set(sessionId, set)
      return () => { set.delete(f); if (!set.size) subs.delete(sessionId) }
    },
  }
}
export type Hub = ReturnType<typeof createHub>
