#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `--import tsx` 会按 cwd 解析，在别的目录里跑 `hue` 就会找不到包。
// 从本文件的位置解析，才能在任意工作目录使用。
const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '../src/cli.ts')
const tsx = import.meta.resolve('tsx')
const child = spawn(process.execPath, ['--import', tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
child.on('exit', code => process.exit(code ?? 1))
child.on('error', err => { console.error(err.message); process.exit(1) })
