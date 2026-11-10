/** 斜杠补全按当前行解析，避免 pi-tui 用过期前缀把默认高亮项拼进命令名。 */
import { CombinedAutocompleteProvider, type AutocompleteItem } from '@earendil-works/pi-tui'
import { applySlashNameCompletion } from './commands.js'

export class HueAutocompleteProvider extends CombinedAutocompleteProvider {
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[], cursorLine: number, cursorCol: number } {
    const current = lines[cursorLine] ?? ''
    const applied = applySlashNameCompletion(current, cursorCol, item.value)
    if (applied) {
      const next = lines.slice()
      next[cursorLine] = applied.line
      return { lines: next, cursorLine, cursorCol: applied.cursorCol }
    }
    return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }
}
