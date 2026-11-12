import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadEnvFiles, parseEnv } from '../src/env.js'

test('parseEnv 忽略空行和注释，去掉引号', () => {
  const v = parseEnv('# x\nFOO=bar\nBAZ="qux"\nQUUX=\'a b\'\nNOPE\n=bad\n')
  assert.deepEqual(v, { FOO: 'bar', BAZ: 'qux', QUUX: 'a b' })
})

test('loadEnvFiles 先读 cwd 的 .env.local，不覆盖已有环境变量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hue-env-'))
  writeFileSync(join(dir, '.env.local'), 'AI_GATEWAY_API_KEY=from-file\nHUE_MODEL=from-file\n')
  writeFileSync(join(dir, '.env'), 'HUE_MODEL=from-env\nEXTRA=1\n')
  const env: NodeJS.ProcessEnv = { AI_GATEWAY_API_KEY: 'already' }
  const loaded = loadEnvFiles({ cwd: dir, env })
  assert.ok(loaded[0]?.endsWith('.env.local'))
  assert.equal(env.AI_GATEWAY_API_KEY, 'already')
  assert.equal(env.HUE_MODEL, 'from-file')
  assert.equal(env.EXTRA, '1')
})
