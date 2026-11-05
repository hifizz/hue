/** EventStore 合同。@hue/store 的每个实现（memory、sqlite…）都必须过。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventStore, HueEvent } from '../src/index.js'
import { fold } from '../src/index.js'

const ev = (sessionId: string, seq: number, extra: object = {}): HueEvent =>
  ({ v: 1, id: `${sessionId}-${seq}`, sessionId, seq, at: seq, type: 'turn.started', turnId: 't', ...extra }) as HueEvent

const all = async (it: AsyncIterable<HueEvent>) => { const a: HueEvent[] = []; for await (const e of it) a.push(e); return a }

export function eventStoreContract(name: string, make: () => Promise<EventStore>): void {
  test(`${name}: append/read preserves order and content`, async () => {
    const s = await make()
    await s.append([ev('a', 1), ev('a', 2)]); await s.append([ev('a', 3)])
    const got = await all(s.read('a'))
    assert.deepEqual(got.map(e => e.seq), [1, 2, 3]); assert.deepEqual(got[0], ev('a', 1))
    assert.equal(await s.lastSeq('a'), 3); assert.equal(await s.lastSeq('nope'), 0)
  })
  test(`${name}: sessions are isolated; fromSeq is inclusive`, async () => {
    const s = await make()
    await s.append([ev('a', 1), ev('b', 1), ev('a', 2)])
    assert.deepEqual((await all(s.read('a', { fromSeq: 2 }))).map(e => e.seq), [2])
    assert.equal((await all(s.read('b'))).length, 1)
  })
  test(`${name}: rejects non-contiguous or duplicate seq`, async () => {
    const s = await make()
    await s.append([ev('a', 1)])
    await assert.rejects(s.append([ev('a', 1)]))
    await assert.rejects(s.append([ev('a', 3)]))
  })
  test(`${name}: rejects ephemeral events`, async () => {
    const s = await make()
    await assert.rejects(s.append([{ ...ev('a', 0), type: 'model.delta', kind: 'text', delta: 'x' } as HueEvent]))
  })
  test(`${name}: batch append is atomic`, async () => {
    const s = await make()
    await assert.rejects(s.append([ev('a', 1), ev('a', 5)]))
    assert.equal(await s.lastSeq('a'), 0)
  })
  test(`${name}: fold(read()) rebuilds state`, async () => {
    const s = await make()
    await s.append([ev('a', 1), { ...ev('a', 2), type: 'user.message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } as HueEvent])
    assert.equal(fold('a', await all(s.read('a'))).transcript.length, 1)
  })
}
