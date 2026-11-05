/** PolicyPort 合同。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PolicyCall, PolicyPort } from '../src/index.js'

export const call = (tool: string, input: object = {}, effects: PolicyCall['effects'] = 'unsafe'): PolicyCall =>
  ({ sessionId: 's', turnId: 't', callId: 'c', tool, effects, input: input as never })

export function policyPortContract(name: string, make: () => PolicyPort, cases: Array<{ call: PolicyCall; expect: 'allow' | 'deny' | 'ask' }>): void {
  const p = make()
  test(`${name}: specVersion`, () => assert.equal(p.specVersion, 'hue.policy.v1'))
  for (const [i, c] of cases.entries()) test(`${name}: case ${i} ${c.call.tool} → ${c.expect}`, async () => {
    const d = await p.decide(c.call, new AbortController().signal)
    assert.equal(d.action, c.expect)
    if (d.action === 'deny') assert.ok(d.reason.length > 0, 'deny must say why (model reads it)')
    if (d.action === 'ask') assert.ok(d.prompt.length > 0)
  })
  test(`${name}: deterministic`, async () => {
    for (const c of cases) {
      const a = await p.decide(c.call, new AbortController().signal), b = await p.decide(c.call, new AbortController().signal)
      assert.deepEqual(a, b)
    }
  })
}
