import type { Tool } from '@hue/core'
import { bash, type BashOptions } from './bash.js'
import { edit } from './edit.js'
import { list } from './list.js'
import { read } from './read.js'
import { glob, grep } from './search.js'
import { write } from './write.js'

export { bash, edit, glob, grep, list, read, write }
export type { BashOptions }
export type { ToolOptions } from './util.js'

/** 全套内置工具。顺序固定：工具列表是 prompt cache 前缀的一部分，顺序变了缓存就失效。 */
export const codingTools = (o: BashOptions = {}): Tool[] => [read(o), list(o), glob(o), grep(o), edit(o), write(o), bash(o)]
