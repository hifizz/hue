import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCwd, formatDuration, formatTokens, formatToolLine } from '../src/tui/theme.js'

test('formatTokens 用 k/M 缩写', () => {
  assert.equal(formatTokens(12), '12')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(12000), '12k')
})

test('formatCwd 把家目录写成 ~', () => {
  assert.equal(formatCwd('/Users/zilin/side/hue-project', '/Users/zilin'), '~/side/hue-project')
  assert.equal(formatCwd('/tmp/work', '/Users/zilin'), '/tmp/work')
})

test('formatDuration 和工具行', () => {
  assert.equal(formatDuration(4200), '4.2s')
  const collapsed = formatToolLine('read', { path: 'token.txt' }, false)
  assert.match(collapsed, /read/)
  assert.match(collapsed, /path=/)
  const expanded = formatToolLine('read', { path: 'token.txt' }, true)
  assert.match(expanded, /path: token.txt/)
})
