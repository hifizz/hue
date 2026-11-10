/** 工作目录下的会话侧车：上次会话 id、显示名。不进事件日志，也不改 core。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const hueDir = (cwd: string) => join(cwd, '.hue')
export const lastSessionFile = (cwd: string) => join(hueDir(cwd), 'last-session')
export const namesFile = (cwd: string) => join(hueDir(cwd), 'session-names.json')

function ensureDir(cwd: string): void {
  mkdirSync(hueDir(cwd), { recursive: true })
}

export function readLastSession(cwd: string): string | undefined {
  const p = lastSessionFile(cwd)
  if (!existsSync(p)) return undefined
  const id = readFileSync(p, 'utf8').trim()
  return id || undefined
}

export function writeLastSession(cwd: string, sessionId: string): void {
  ensureDir(cwd)
  writeFileSync(lastSessionFile(cwd), `${sessionId}\n`)
}

export function readSessionNames(cwd: string): Record<string, string> {
  const p = namesFile(cwd)
  if (!existsSync(p)) return {}
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>
  } catch { /* 坏掉的侧车就当没有 */ }
  return {}
}

export function sessionName(cwd: string, sessionId: string): string | undefined {
  const name = readSessionNames(cwd)[sessionId]?.trim()
  return name || undefined
}

export function writeSessionName(cwd: string, sessionId: string, name: string): void {
  ensureDir(cwd)
  const names = readSessionNames(cwd)
  const trimmed = name.trim()
  if (trimmed) names[sessionId] = trimmed
  else delete names[sessionId]
  writeFileSync(namesFile(cwd), `${JSON.stringify(names, null, 2)}\n`)
}
