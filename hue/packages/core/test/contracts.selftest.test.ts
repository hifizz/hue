import { eventStoreContract, policyPortContract, call, toolContract } from '../contracts/index.js'
import { isDurable, textResult } from '../src/index.js'
import type { EventStore, HueEvent } from '../src/index.js'
const mem = async (): Promise<EventStore> => { const m = new Map<string, HueEvent[]>()
  return { specVersion: 'hue.store.v1',
    async append(es) { const next = new Map<string, number>()
      for (const e of es) { if (!isDurable(e)) throw new Error('ephemeral'); const last = next.get(e.sessionId) ?? (m.get(e.sessionId)?.length ?? 0); if (e.seq !== last + 1) throw new Error('seq'); next.set(e.sessionId, e.seq) }
      for (const e of es) m.set(e.sessionId, [...(m.get(e.sessionId) ?? []), structuredClone(e)]) },
    async *read(id, o) { for (const e of m.get(id) ?? []) if (e.seq >= (o?.fromSeq ?? 1)) yield e },
    async lastSeq(id) { return m.get(id)?.length ?? 0 } } }
eventStoreContract('memory', mem)
policyPortContract('allow-reads', () => ({ specVersion: 'hue.policy.v1', decide: async c => c.effects === 'none' ? { action: 'allow' } : { action: 'ask', prompt: `run ${c.tool}?` } }),
  [{ call: call('read', {}, 'none'), expect: 'allow' }, { call: call('bash'), expect: 'ask' }])
toolContract({ name: 'echo', description: 'echo the text back', inputSchema: { type: 'object' }, effects: 'none',
  parse: (i: any) => { if (typeof i?.text !== 'string') throw new Error('text'); return i },
  execute: async (i: any, ctx) => { ctx.signal.throwIfAborted(); return textResult(i.text) } }, { valid: { text: 'x' }, invalid: {} })
