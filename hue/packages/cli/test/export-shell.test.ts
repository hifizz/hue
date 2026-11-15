import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HueEvent } from '@hue/core'
import { sessionJsonl, sessionMarkdown } from '../src/export.js'
import type { Recipe } from '../src/recipe.js'
import { runBang } from '../src/shell.js'

const ev = (e: object) => e as unknown as HueEvent
const events = [
  ev({ type: 'user.message', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }),
  ev({ type: 'tool.call', name: 'read', input: { path: 'a.ts' } }),
  ev({ type: 'tool.result', isError: true, content: [{ type: 'text', text: '没找到' }] }),
]

test('sessionMarkdown：用户、工具调用、错误结果各有标题', () => {
  const md = sessionMarkdown('abc', events)
  assert.match(md, /^# Hue 会话 abc/)
  assert.match(md, /## 你\n\n你好/)
  assert.match(md, /## 工具 read/)
  assert.match(md, /### 错误\n\n```\n没找到/)
})

test('sessionJsonl：一行一个事件，空会话是空串', () => {
  assert.equal(sessionJsonl(events).trimEnd().split('\n').length, 3)
  assert.equal(sessionJsonl([]), '')
})

const recipeWith = (tools: object[], action: string): Recipe => ({
  tools,
  policy: { decide: async () => ({ action, reason: '不让', prompt: '' }) },
  sandbox: {},
}) as unknown as Recipe

const ask = async () => ({ action: 'accept' as const })

test('runBang：没有 bash 工具、被拒绝、被用户拒绝都不会产生 block', async () => {
  const none = await runBang({ recipe: recipeWith([], 'allow'), sessionId: 's', command: 'ls', ask })
  assert.deepEqual([none.isError, none.block], [true, undefined])
  const bash = { name: 'bash', effects: 'write', execute: async () => ({ content: [{ type: 'text', text: 'x' }] }) }
  const denied = await runBang({ recipe: recipeWith([bash], 'deny'), sessionId: 's', command: 'rm -rf /', ask })
  assert.match(denied.text, /不让/)
  assert.equal(denied.block, undefined)
  const declined = await runBang({ recipe: recipeWith([bash], 'ask'), sessionId: 's', command: 'ls', ask: async () => ({ action: 'decline' as const }) })
  assert.equal(declined.block, undefined)
})

test('runBang：执行后 block 是 `$ 命令` 加输出', async () => {
  const bash = { name: 'bash', effects: 'write', execute: async () => ({ content: [{ type: 'text', text: 'hello' }] }) }
  const r = await runBang({ recipe: recipeWith([bash], 'allow'), sessionId: 's', command: 'echo hello', ask })
  assert.equal(r.block, '$ echo hello\nhello')
  assert.equal(r.isError, false)
})
