import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `hue/` 目录（本文件在 packages/cli/src/）。 */
export function hueRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    let v = line.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[line.slice(0, i).trim()] = v
  }
  return out
}

/** 读入 .env.local / .env：已在进程环境里的键不覆盖。返回实际读过的路径。 */
export function loadEnvFiles(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const cwd = resolve(opts.cwd ?? process.cwd())
  const env = opts.env ?? process.env
  const seen = new Set<string>()
  const loaded: string[] = []
  for (const f of [join(cwd, '.env.local'), join(cwd, '.env'), join(hueRoot(), '.env.local'), join(hueRoot(), '.env')]) {
    const path = resolve(f)
    if (seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    const vars = parseEnv(readFileSync(path, 'utf8'))
    for (const [k, v] of Object.entries(vars)) {
      if (env[k] === undefined) env[k] = v
    }
    loaded.push(path)
  }
  return loaded
}
