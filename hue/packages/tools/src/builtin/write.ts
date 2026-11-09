import { posix } from 'node:path'
import { textResult } from '@hue/core'
import { defineTool, quote, resolvePath, type ToolOptions } from './util.js'

export const write = (o: ToolOptions = {}) => defineTool<{ path: string; content: string }>({
  name: 'write',
  description: 'Create a file or completely replace its content. Parent directories are created. To change part of an existing file use edit instead: write overwrites everything, so anything you leave out is lost.',
  effects: 'idempotent', // 同样的参数执行两次，结果一样
  fields: {
    path: { type: 'string', required: true, description: 'File path, relative to the working directory or absolute.' },
    content: { type: 'string', required: true, description: 'The complete new content of the file.' },
  },
  async run({ path, content }, sandbox, ctx) {
    const full = resolvePath(path, o.cwd)
    const dir = posix.dirname(full)
    // writeFile 不保证会建目录，而模型经常往新目录里写。
    if (dir !== '.' && dir !== '/') {
      const r = await sandbox.exec(`mkdir -p -- ${quote(dir)}`, { cwd: o.cwd, signal: ctx.signal })
      if (r.exitCode !== 0) return textResult(`could not create directory ${dir}: ${r.stderr.trim()}`, true)
    }
    await sandbox.writeFile(full, content, ctx.signal)
    return textResult(`Wrote ${Buffer.byteLength(content)} bytes (${content === '' ? 0 : content.split('\n').length} lines) to ${path}.`)
  },
})
