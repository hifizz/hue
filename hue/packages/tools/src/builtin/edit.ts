import { textResult } from '@hue/core'
import { defineTool, resolvePath, type ToolOptions } from './util.js'

export const edit = (o: ToolOptions = {}) => defineTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>({
  name: 'edit',
  description: 'Replace an exact piece of text in an existing file. old_string must match the file exactly (whitespace and indentation included) and must appear exactly once, otherwise add surrounding lines to make it unique, or set replace_all to change every occurrence. Read the file first. To create a file use write.',
  effects: 'idempotent', // 重复执行第二次会因找不到原文而失败，但不会改坏文件
  fields: {
    path: { type: 'string', required: true, description: 'File to modify, relative to the working directory or absolute.' },
    old_string: { type: 'string', required: true, description: 'The exact text to replace. Must be non-empty.' },
    new_string: { type: 'string', required: true, description: 'The replacement text. Must differ from old_string; may be empty to delete.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Default false.' },
  },
  async run({ path, old_string, new_string, replace_all = false }, sandbox, ctx) {
    if (old_string === '') return textResult('old_string must not be empty. To create a file use write.', true)
    if (old_string === new_string) return textResult('old_string and new_string are identical; nothing to change.', true)

    const bytes = await sandbox.readFile(resolvePath(path, o.cwd), ctx.signal)
    let text: string
    // fatal：不是合法 UTF-8 就拒绝。否则解码成 � 再写回，会悄悄破坏二进制文件。
    // ignoreBOM：保留开头的 BOM，写回时才不会丢。
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return textResult(`${path} is not valid UTF-8 text; refusing to edit it.`, true) }

    // CRLF 文件：模型写的 old_string 几乎总是 LF。统一成 LF 匹配，写回时再还原。
    const crlf = text.includes('\r\n')
    const norm = (s: string) => s.replace(/\r\n/g, '\n')
    const body = crlf ? norm(text) : text
    const oldS = norm(old_string), newS = norm(new_string)

    const count = body.split(oldS).length - 1
    if (count === 0) {
      const hint = body.includes(oldS.trim()) ? ' It does appear when leading/trailing whitespace is ignored: check the indentation and line breaks.' : ' Check for typos, and read the file again in case it changed.'
      return textResult(`old_string was not found in ${path}.${hint}`, true)
    }
    if (count > 1 && !replace_all) return textResult(`old_string appears ${count} times in ${path}. Add more surrounding lines to make it unique, or set replace_all to true.`, true)

    // 用 split/join 而不是 String.replace：后者会把 new_string 里的 "$&" 之类当成特殊替换模式。
    const next = body.split(oldS).join(newS)
    await sandbox.writeFile(resolvePath(path, o.cwd), crlf ? next.replace(/\n/g, '\r\n') : next, ctx.signal)
    return textResult(`Edited ${path}: replaced ${count} occurrence${count === 1 ? '' : 's'}.`)
  },
})
