import assert from 'node:assert/strict'
import { test } from 'node:test'
import { color, formatCwd, formatDuration, formatTokens, formatToolTitle, toolDot } from '../src/tui/theme.js'

test('formatTokens 用 k/M 缩写', () => {
  assert.equal(formatTokens(12), '12')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(12000), '12k')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(1_500_000), '1.5M')
})

test('formatCwd 把家目录写成 ~', () => {
  assert.equal(formatCwd('/Users/zilin/side/hue-project', '/Users/zilin'), '~/side/hue-project')
  assert.equal(formatCwd('/tmp/work', '/Users/zilin'), '/tmp/work')
})

test('formatDuration 和工具行', () => {
  assert.equal(formatDuration(4200), '4.2s')
  const collapsed = formatToolTitle('read', { path: 'token.txt' }, false)
  assert.match(collapsed, /read.*\(.*token\.txt.*\)/)
  const expanded = formatToolTitle('read', { path: 'token.txt' }, true)
  assert.match(expanded, /path: token.txt/)
})

test('工具标题：edit 只显示路径，子 agent 用蓝点', () => {
  const edit = formatToolTitle('edit', { path: 'a.ts', old_string: 'x', new_string: 'y' }, false)
  assert.match(edit, /a\.ts/)
  assert.doesNotMatch(edit, /old_string|new_string/)
  assert.notEqual(toolDot('ok', 'task'), toolDot('ok', 'read'))
  assert.notEqual(toolDot('error'), toolDot('ok'))
  assert.match(toolDot('ok'), /●/)
})

test('NO_COLOR 时不输出转义序列', () => {
  const prev = process.env.NO_COLOR
  try {
    process.env.NO_COLOR = '1'
    assert.equal(color.orange('x'), 'x')
    assert.equal(formatToolTitle('bash', { cmd: 'ls' }, false).includes('\x1b'), false)
    assert.equal(toolDot('ok'), '●')
    delete process.env.NO_COLOR
    assert.match(color.orange('x'), /\x1b\[/)
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prev
  }
})
