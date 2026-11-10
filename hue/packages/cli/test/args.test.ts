import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs } from '../src/args.js'

test('解析 -p 和提示词，默认 docker 和 cwd', () => {
  const a = parseArgs(['-p', 'fix the bug'], '/tmp/work')
  assert.equal(a.print, true)
  assert.equal(a.prompt, 'fix the bug')
  assert.equal(a.sandbox, 'docker')
  assert.equal(a.cwd, '/tmp/work')
  assert.equal(a.help, false)
})

test('--json 隐含 -p；多段提示词拼成一句', () => {
  const a = parseArgs(['--json', '--sandbox', 'local', '--model', 'glm-5.3-flash', '只回复', 'pong'])
  assert.equal(a.print, true)
  assert.equal(a.json, true)
  assert.equal(a.sandbox, 'local')
  assert.equal(a.model, 'glm-5.3-flash')
  assert.equal(a.prompt, '只回复 pong')
})

test('-- 之后的参数都是提示词，即使以 - 开头', () => {
  const a = parseArgs(['-p', '--', '-not-a-flag', 'ok'])
  assert.equal(a.prompt, '-not-a-flag ok')
})

test('未知选项和缺失参数会抛错', () => {
  assert.throws(() => parseArgs(['-p', '--nope']), /未知选项/)
  assert.throws(() => parseArgs(['-p', '--model']), /需要一个参数/)
  assert.throws(() => parseArgs(['-p', '--sandbox', 'wasm']), /只能是 docker 或 local/)
})

test('--help 不要求提示词', () => {
  const a = parseArgs(['-h'])
  assert.equal(a.help, true)
  assert.equal(a.prompt, undefined)
})
