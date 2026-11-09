import { textResult } from '@hue/core'
import { DEFAULT_MAX_BYTES, defineTool, truncate, type ToolOptions } from './util.js'

export interface BashOptions extends ToolOptions {
  /** 命令超时，默认 120s。到时由 sandbox 杀进程，工具返回已有的输出。 */
  timeoutMs?: number
}

export const bash = (o: BashOptions = {}) => {
  const timeoutMs = o.timeoutMs ?? 120_000
  return defineTool<{ command: string }>({
    name: 'bash',
    description: `Run a shell command and return its stdout, stderr and exit code. Commands are killed after ${Math.round(timeoutMs / 1000)}s, so do not start servers or watchers. Each call is a fresh shell: cd and exported variables do not persist. Very long output is cut in the middle; pipe through grep, head or tail, or redirect to a file and use read.`,
    effects: 'unsafe', // 不可重复，崩溃后不自动重跑；是否允许由 policy 决定
    // 比 sandbox 的超时多留一点：让 sandbox 先杀进程、返回结构化结果，loop 的兜底超时只在 sandbox 失灵时才触发。
    timeoutMs: timeoutMs + 10_000,
    fields: { command: { type: 'string', required: true, description: 'The shell command to run.' } },
    async run({ command }, sandbox, ctx) {
      const r = await sandbox.exec(command, { cwd: o.cwd, timeoutMs, signal: ctx.signal })
      const text = [
        r.stdout.trimEnd(),
        r.stderr.trim() && `[stderr]\n${r.stderr.trimEnd()}`,
        r.timedOut ? `[timed out after ${Math.round(timeoutMs / 1000)}s and was killed]` : `[exit code ${r.exitCode}]`,
      ].filter(Boolean).join('\n')
      // headRatio 0.4：命令输出的错误和总结在结尾，所以多留结尾。
      return textResult(truncate(text, o.maxOutputBytes ?? DEFAULT_MAX_BYTES, 'Filter the output (grep/head/tail) or redirect it to a file and use read with offset.', 0.4), r.timedOut || r.exitCode !== 0)
    },
  })
}
