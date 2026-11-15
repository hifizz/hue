import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INSTRUCTIONS, instructionsFor } from '../src/recipe.js'

test('instructionsFor：没开缓存就是 INSTRUCTIONS 本身；开了带 store 路径提示', () => {
  assert.equal(instructionsFor(false), INSTRUCTIONS)
  const on = instructionsFor(true)
  assert.ok(on.startsWith(INSTRUCTIONS), '原话不变，只是追加')
  assert.match(on, /\/pnpm-store/, '告诉模型 store 挂在哪')
})
