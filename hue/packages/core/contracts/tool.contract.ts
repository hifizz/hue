/** Tool 合同：每个内置工具、每个 MCP 适配出来的工具都过一遍。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Json, Tool, ToolContext } from '../src/index.js'

export const fakeCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal, sessionId: 's', turnId: 't', callId: 'c',
  progress: () => {}, requestInput: async () => ({ action: 'cancel' }), ...over,
})

export function toolContract(tool: Tool, sample: { valid: Json; invalid?: Json; ctx?: () => ToolContext }): void {
  test(`${tool.name}: well-formed spec`, () => {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/, 'provider-safe name')
    assert.ok(tool.description.length >= 10, 'description is the model\'s only manual')
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(['none', 'idempotent', 'unsafe'].includes(tool.effects))
    JSON.stringify(tool.inputSchema)
  })
  test(`${tool.name}: valid input executes and output is Json`, async () => {
    const input = tool.parse ? tool.parse(sample.valid) : sample.valid
    const out = await tool.execute(input as never, (sample.ctx ?? fakeCtx)())
    assert.ok(Array.isArray(out.content) && out.content.length > 0); JSON.stringify(out)
  })
  if (sample.invalid !== undefined) test(`${tool.name}: invalid input is rejected by parse`, () => {
    assert.ok(tool.parse, 'tool with invalid sample must implement parse'); assert.throws(() => tool.parse!(sample.invalid!))
  })
  test(`${tool.name}: honours an already-aborted signal`, async () => {
    const ac = new AbortController(); ac.abort()
    const input = tool.parse ? tool.parse(sample.valid) : sample.valid
    await assert.rejects(tool.execute(input as never, { ...(sample.ctx ?? fakeCtx)(), signal: ac.signal }))
  })
}
