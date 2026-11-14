import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCwd, formatDuration, formatTokens } from '../src/tui/theme.js'
import { toolSig } from '../src/tui/blocks.js'

test('formatTokens 用 k/M 缩写', () => {
  assert.equal(formatTokens(12), '12')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(12000), '12k')
})

test('formatCwd 把家目录写成 ~', () => {
  assert.equal(formatCwd('/Users/zilin/side/hue-project', '/Users/zilin'), '~/side/hue-project')
  assert.equal(formatCwd('/tmp/work', '/Users/zilin'), '/tmp/work')
})

test('formatDuration', () => {
  assert.equal(formatDuration(4200), '4.2s')
})

test('toolSig 每个工具挑关键参数', () => {
  assert.equal(toolSig('read', { path: 'token.txt' }), '(token.txt)')
  assert.equal(toolSig('bash', { command: 'npm test' }), '(npm test)')
  assert.equal(toolSig('grep', { pattern: 'expiresAt', path: 'src/' }), '("expiresAt", src/)')
  assert.equal(toolSig('grep', { pattern: 'x', path: 'src/', glob: '*.ts' }), '("x", src/, *.ts)')
  assert.equal(toolSig('task', { task: '查一下' }), '(查一下)')
  assert.equal(toolSig('mcp_tool', {}), '')
})
