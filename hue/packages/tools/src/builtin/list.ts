import { textResult } from '@hue/core'
import { DEFAULT_MAX_BYTES, defineTool, resolvePath, truncate, type ToolOptions } from './util.js'

export const list = (o: ToolOptions = {}) => defineTool<{ path?: string }>({
  name: 'list',
  description: 'List the entries of one directory (not recursive). Directories come first and end with "/". Use glob to find files by pattern across subdirectories.',
  effects: 'none',
  fields: { path: { type: 'string', description: 'Directory path. Default: the working directory.' } },
  async run({ path = '.' }, sandbox, ctx) {
    const entries = await sandbox.list(resolvePath(path, o.cwd), ctx.signal)
    if (entries.length === 0) return textResult(`${path} is empty.`)
    const rank = (t: string) => (t === 'dir' ? 0 : 1)
    const names = entries.sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name)).map(e => e.type === 'dir' ? `${e.name}/` : e.name)
    return textResult(truncate(names.join('\n'), o.maxOutputBytes ?? DEFAULT_MAX_BYTES, 'Narrow it down with glob.'))
  },
})
