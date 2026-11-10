import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SLASH_NAMES, parseShellBang, parseSlash } from '../src/tui/commands.js'

test('第一批斜杠命令都在表里', () => {
  for (const name of ['quit', 'new', 'resume', 'session', 'model', 'copy', 'name', 'export', 'hotkeys']) {
    assert.equal(SLASH_NAMES.has(name), true, name)
  }
  assert.equal(SLASH_NAMES.has('compact'), false)
  assert.equal(SLASH_NAMES.has('share'), false)
})

test('parseSlash 拆出命令名和参数', () => {
  assert.deepEqual(parseSlash('/model glm-5.3-flash'), { name: 'model', args: 'glm-5.3-flash' })
  assert.deepEqual(parseSlash('/quit'), { name: 'quit', args: '' })
  assert.equal(parseSlash('hello'), undefined)
})

test('! 把输出纳入对话，!! 不送给模型', () => {
  assert.deepEqual(parseShellBang('!git status'), { command: 'git status', sendToModel: true })
  assert.deepEqual(parseShellBang('!!ls -l'), { command: 'ls -l', sendToModel: false })
  assert.equal(parseShellBang('!'), undefined)
  assert.equal(parseShellBang('not a shell'), undefined)
})
