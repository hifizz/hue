import { textResult } from '@hue/core'
import { DEFAULT_MAX_BYTES, defineTool, resolvePath, type ToolOptions } from './util.js'

const MAX_LINE_CHARS = 2000
const FOOTER_RESERVE = 200

export const read = (o: ToolOptions = {}) => defineTool<{ path: string; offset?: number; limit?: number }>({
  name: 'read',
  description: 'Read a text file and return it with line numbers ("  12\\tcode"). Use offset (1-based line) and limit (max lines, default 2000) to page through large files; the result says how to continue when it is cut off. Binary files are not shown. Always read a file before editing it.',
  effects: 'none',
  fields: {
    path: { type: 'string', required: true, description: 'File path, relative to the working directory or absolute.' },
    offset: { type: 'integer', min: 1, description: 'First line to return (1-based). Default 1.' },
    limit: { type: 'integer', min: 1, description: 'Maximum number of lines to return. Default 2000.' },
  },
  async run({ path, offset = 1, limit = 2000 }, sandbox, ctx) {
    const bytes = await sandbox.readFile(resolvePath(path, o.cwd), ctx.signal)
    if (bytes.subarray(0, 8000).includes(0)) return textResult(`${path} looks like a binary file (${bytes.length} bytes); not shown.`)
    const lines = new TextDecoder().decode(bytes).split('\n')
    if (lines.at(-1) === '') lines.pop() // 文件以换行结尾时 split 会多出一个空串
    if (lines.length === 0) return textResult(`${path} is empty.`)
    if (offset > lines.length) return textResult(`offset ${offset} is past the end of ${path} (${lines.length} lines).`, true)

    const budget = (o.maxOutputBytes ?? DEFAULT_MAX_BYTES) - FOOTER_RESERVE
    const out: string[] = []
    let used = 0, i = offset - 1
    for (; i < lines.length && out.length < limit; i++) {
      let line = lines[i]!.replace(/\r$/, '')
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)} …[line truncated]`
      const text = `${String(i + 1).padStart(6)}\t${line}`
      used += Buffer.byteLength(text) + 1
      if (used > budget && out.length > 0) break // 至少给一行，否则超长单行会让模型永远读不到东西
      out.push(text)
    }
    const last = offset - 1 + out.length // 最后一个已显示的行号
    if (last < lines.length) out.push(`[showing lines ${offset}-${last} of ${lines.length}; call read again with offset=${last + 1} to continue]`)
    return textResult(out.join('\n'))
  },
})
