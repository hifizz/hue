import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HueEvent } from '@hue/core'
import { jsonPrinter, textPrinter } from '../src/print.js'

const ev = (e: object) => e as HueEvent

test('textPrinter 流式输出文本，并在工具调用和结束时换行', () => {
  const buf: string[] = []
  const p = textPrinter(s => buf.push(s))
  p(ev({ type: 'model.delta', kind: 'text', delta: 'hi' }))
  p(ev({ type: 'model.delta', kind: 'reasoning', delta: 'secret' }))
  p(ev({ type: 'tool.call', name: 'bash', input: { command: 'ls' } }))
  p(ev({ type: 'tool.result', isError: true, content: [{ type: 'text', text: 'nope' }] }))
  p(ev({ type: 'turn.ended', reason: 'stop', steps: 1, usage: { input: 1, output: 2 } }))
  const out = buf.join('')
  assert.match(out, /^hi/)
  assert.doesNotMatch(out, /secret/)
  assert.match(out, /▶ bash/)
  assert.match(out, /✗ nope/)
  assert.match(out, /结束: stop/)
})

test('jsonPrinter 每条事件一行', () => {
  const buf: string[] = []
  const p = jsonPrinter(s => buf.push(s))
  p(ev({ type: 'model.delta', kind: 'text', delta: 'hi' }))
  assert.equal(buf.length, 1)
  assert.equal(JSON.parse(buf[0]!).delta, 'hi')
})
