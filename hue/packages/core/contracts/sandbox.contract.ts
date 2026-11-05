/** SandboxPort 合同。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SandboxPort } from '../src/index.js'

export function sandboxPortContract(name: string, make: () => Promise<SandboxPort>, opts: { workdir: string }): void {
  test(`${name}: exec stdout/stderr/exitCode`, async () => {
    const s = await make()
    const r = await s.exec('echo out; echo err 1>&2; exit 3', { cwd: opts.workdir })
    assert.equal(r.stdout.trim(), 'out'); assert.equal(r.stderr.trim(), 'err'); assert.equal(r.exitCode, 3); assert.equal(r.timedOut, false)
  })
  test(`${name}: timeout kills the process`, async () => {
    const s = await make(); const t0 = Date.now()
    const r = await s.exec('sleep 10', { cwd: opts.workdir, timeoutMs: 300 })
    assert.equal(r.timedOut, true); assert.ok(Date.now() - t0 < 3000)
  })
  test(`${name}: abort rejects with AbortError`, async () => {
    const s = await make(); const ac = new AbortController(); setTimeout(() => ac.abort(), 100)
    await assert.rejects(s.exec('sleep 10', { cwd: opts.workdir, signal: ac.signal }), (e: any) => e?.name === 'AbortError')
  })
  test(`${name}: file round-trip and list`, async () => {
    const s = await make()
    await s.writeFile(`${opts.workdir}/hue-contract.txt`, 'héllo')
    assert.equal(new TextDecoder().decode(await s.readFile(`${opts.workdir}/hue-contract.txt`)), 'héllo')
    assert.ok((await s.list(opts.workdir)).some(e => e.name === 'hue-contract.txt' && e.type === 'file'))
  })
  test(`${name}: env and stdin`, async () => {
    const s = await make()
    const r = await s.exec('cat; printf "$HUE_X"', { cwd: opts.workdir, env: { HUE_X: 'y' }, stdin: 'in-' })
    assert.equal(r.stdout, 'in-y')
  })
}
