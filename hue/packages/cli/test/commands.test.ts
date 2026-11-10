import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HueAutocompleteProvider } from '../src/tui/autocomplete.js'
import { applySlashNameCompletion, resolveSlashCompletion, SLASH_COMMANDS, SLASH_NAMES, parseShellBang, parseSlash } from '../src/tui/commands.js'

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

test('resolveSlashCompletion 在前缀过期时仍用已输入的命令名', () => {
  assert.equal(resolveSlashCompletion('session', 'model'), 'session')
  assert.equal(resolveSlashCompletion('', 'model'), 'model')
  assert.equal(resolveSlashCompletion('se', 'model'), 'session')
  assert.equal(resolveSlashCompletion('n', 'name'), 'name')
  assert.equal(resolveSlashCompletion('n', 'model'), 'n')
})

test('applySlashNameCompletion 不会把 model 拼进 /session', () => {
  const stale = applySlashNameCompletion('/session', 8, 'model')
  assert.deepEqual(stale, { line: '/session ', cursorCol: 9 })
  const acceptDefault = applySlashNameCompletion('/', 1, 'model')
  assert.deepEqual(acceptDefault, { line: '/model ', cursorCol: 7 })
})

test('HueAutocompleteProvider 用过期前缀 / 接受 session 时不会生成 /sessiomodel', () => {
  const provider = new HueAutocompleteProvider([...SLASH_COMMANDS], '.')
  const result = provider.applyCompletion(['/session'], 0, 8, { value: 'model', label: 'model' }, '/')
  assert.equal(result.lines[0], '/session ')
  assert.equal(result.cursorCol, 9)
})
