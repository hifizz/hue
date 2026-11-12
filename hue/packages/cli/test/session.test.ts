import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readLastSession, sessionName, writeLastSession, writeSessionName } from '../src/session.js'

test('读写最近会话和显示名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hue-cli-session-'))
  try {
    assert.equal(readLastSession(dir), undefined)
    writeLastSession(dir, 'abc-123')
    assert.equal(readLastSession(dir), 'abc-123')
    assert.equal(sessionName(dir, 'abc-123'), undefined)
    writeSessionName(dir, 'abc-123', 'demo')
    assert.equal(sessionName(dir, 'abc-123'), 'demo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
