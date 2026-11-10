import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { textResult } from '@hue/core'
import type { Capability, Tool } from '@hue/core'
import { parseFrontmatter } from './frontmatter.js'

export interface Skill { name: string; description: string; dir: string }
export interface Scan { skills: Skill[]; problems: string[] }
export interface SkillsOptions {
  /** 索引里每个描述最多多少字符，默认 200。 */
  maxDescription?: number
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_FILE = 100_000

/** 目录布局：<dir>/<name>/SKILL.md。多个目录时靠前的赢（项目里的盖过用户级的）。不存在的目录当作没有。 */
export async function scan(dirs: string[]): Promise<Scan> {
  const skills: Skill[] = [], problems: string[] = []
  for (const dir of dirs) {
    let entries: string[]
    try { entries = (await readdir(dir)).sort() } catch { continue }
    for (const entry of entries) {
      const skillDir = join(dir, entry)
      let src: string
      try { if (!(await stat(skillDir)).isDirectory()) continue; src = await readFile(join(skillDir, 'SKILL.md'), 'utf8') } catch { continue }
      const fm = parseFrontmatter(src)
      const name = fm?.meta.name, description = fm?.meta.description
      if (!fm) problems.push(`${skillDir}: SKILL.md has no frontmatter`)
      else if (!name || !NAME.test(name) || name.length > 64) problems.push(`${skillDir}: name "${name ?? ''}" must be lowercase letters, digits and hyphens (max 64)`)
      else if (name !== entry) problems.push(`${skillDir}: name "${name}" must match the directory name "${entry}"`)
      else if (!description) problems.push(`${skillDir}: missing description`)
      else if (!skills.some(s => s.name === name)) skills.push({ name, description, dir: skillDir })
    }
  }
  return { skills, problems }
}

const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

export function indexText(skills: Skill[], maxDescription = 200): string {
  return ['You have skills: instructions for specific kinds of tasks. When the task matches one, call load_skill with its name before you start, then follow it.',
    ...skills.map(s => `- ${s.name}: ${oneLine(s.description, maxDescription)}`)].join('\n')
}

async function bundled(dir: string, depth = 0): Promise<string[]> {
  const out: string[] = []
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || (depth === 0 && e.name === 'SKILL.md')) continue
    if (e.isDirectory()) { if (depth < 3) out.push(...(await bundled(join(dir, e.name), depth + 1)).map(f => `${e.name}/${f}`)) }
    else out.push(e.name)
  }
  return out
}

export function fromDir(dir: string | string[], o: SkillsOptions = {}): Capability & { scan(): Promise<Scan> } {
  const dirs = Array.isArray(dir) ? dir : [dir]

  const loadSkill: Tool<{ name: string; file?: string }> = {
    name: 'load_skill', effects: 'none',
    description: 'Load a skill by name: returns its full instructions and the list of files bundled with it. Pass `file` (a path from that list) to read one of those files. Skills are not run for you; to use a bundled script, read it and run it yourself.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string', description: 'Optional: a bundled file, relative to the skill directory.' } }, required: ['name'] },
    parse(input) {
      const { name, file } = (input ?? {}) as { name?: unknown; file?: unknown }
      if (typeof name !== 'string' || !name) throw new Error('`name` must be a non-empty string')
      if (file !== undefined && typeof file !== 'string') throw new Error('`file` must be a string')
      return { name, file }
    },
    async execute({ name, file }, ctx) {
      const { skills } = await scan(dirs)
      const skill = skills.find(s => s.name === name)
      if (!skill) return textResult(`No skill named "${name}". Available: ${skills.map(s => s.name).join(', ') || '(none)'}`, true)
      if (file === undefined) {
        const fm = parseFrontmatter(await readFile(join(skill.dir, 'SKILL.md'), { encoding: 'utf8', signal: ctx.signal }))
        const files = await bundled(skill.dir)
        return textResult(`${fm?.body.trim() ?? ''}\n\n${files.length ? `Bundled files (read with load_skill file=…):\n${files.map(f => `- ${f}`).join('\n')}` : 'No bundled files.'}`)
      }
      // 只能读技能目录里的东西：用真实路径比较，../ 和指向目录外的符号链接都过不去。
      let real: string
      try { real = await realpath(join(skill.dir, file)) } catch { return textResult(`No file "${file}" in skill ${name}.`, true) }
      const root = await realpath(skill.dir)
      if (real !== root && !real.startsWith(root + sep)) return textResult(`"${file}" is outside the skill directory.`, true)
      const st = await stat(real)
      if (!st.isFile()) return textResult(`"${file}" is not a file.`, true)
      if (st.size > MAX_FILE) return textResult(`"${file}" is ${st.size} bytes, over the ${MAX_FILE} limit.`, true)
      const text = await readFile(real, { encoding: 'utf8', signal: ctx.signal })
      return text.includes('\0') ? textResult(`"${relative(skill.dir, real)}" is a binary file.`, true) : textResult(text)
    },
  }

  return {
    name: 'skills',
    scan: () => scan(dirs),
    // 每个 turn 开始时扫一次：新加的技能下个 turn 就能用，turn 内保持不变。
    async instructions() { const { skills } = await scan(dirs); return skills.length ? indexText(skills, o.maxDescription) : undefined },
    async tools() { return (await scan(dirs)).skills.length ? [loadSkill] : [] },
  }
}
