import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Capability, ContextStrategy, HueEvent, InputPort, ModelPort, PolicyPort, SandboxPort } from '@hue/core'
import { model } from '@hue/ai'
import { sqliteStore } from '@hue/store'
import { observeStore, telemetry as makeTelemetry } from '@hue/telemetry'
import type { Telemetry } from '@hue/telemetry'
import { codingTools } from '@hue/tools'
import { docker, local } from '@hue/sandbox'
import { presets } from '@hue/policy'
import { chain, foldToolResults, summarize } from '@hue/context'
import { file as memoryDir } from '@hue/memory'
import { createAgent, drain } from '@hue/runtime'
import type { RunResult } from '@hue/runtime'
import { fromDir as skillsDir } from '@hue/skills'
import type { CliArgs, SandboxMode } from './args.js'
import { jsonPrinter, textPrinter } from './print.js'

export const INSTRUCTIONS = `You are a coding agent working in the current directory (a git repository).
Every tool and shell command already runs in the repository root: use relative paths and never cd to another directory.
Find the cause before changing anything: read the code and run the tests. Make the smallest change that fixes the problem, then re-run the tests to confirm. Say what you changed and why.`

export function modelFromEnv(opts: { model?: string, trace?: (e: object) => void } = {}): ModelPort {
  const name = opts.model ?? process.env.HUE_MODEL ?? 'claude-sonnet-5-5'
  return model(`anthropic:${name}`, {
    apiKey: process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL,
    thinking: { type: 'adaptive', display: 'summarized' },
    trace: opts.trace,
  })
}

export interface RunCliOptions {
  args: CliArgs
  onEvent?: (e: HueEvent) => void
  /** 测试可注入。默认按 sandbox / --yes 选择策略。 */
  policy?: PolicyPort
  signal?: AbortSignal
}

function capabilities(): Capability[] {
  const out: Capability[] = []
  if (process.env.HUE_SKILLS) out.push(skillsDir(process.env.HUE_SKILLS.split(':')))
  if (process.env.HUE_MEMORY) out.push(memoryDir(process.env.HUE_MEMORY))
  return out
}

async function makeSandbox(mode: SandboxMode, dir: string): Promise<{ sandbox: SandboxPort, workdir: string, copy?: string }> {
  const workdir = resolve(dir)
  if (mode === 'local') return { sandbox: await local({ root: workdir }), workdir }
  let copy = process.env.HUE_COPY
  if (!copy) {
    try { execFileSync('git', ['-C', workdir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' }) }
    catch { throw new Error(`docker 模式需要一个 git 仓库，${workdir} 不是`) }
    const dirty = execFileSync('git', ['-C', workdir, 'status', '--porcelain']).toString().trim()
    if (dirty) console.warn('⚠ 原仓库有未提交的改动，副本里没有它们（副本是 git clone）。')
    copy = mkdtempSync(join(tmpdir(), 'hue-work-'))
    execFileSync('git', ['clone', '-q', '--no-hardlinks', workdir, copy])
  }
  const sandbox = await docker({ mount: copy, image: process.env.HUE_IMAGE, network: process.env.HUE_NETWORK })
  return { sandbox, workdir, copy }
}

function policyFor(mode: SandboxMode, yes: boolean): PolicyPort {
  if (mode === 'docker' || yes) return presets.yolo()
  // -p 且 local 又没有 --yes：不能在终端里询问，危险命令一律拒绝，其余按 coding 预设放行。
  return presets.coding()
}

const decline: InputPort = {
  request: async r => ({ action: 'decline', reason: 'non-interactive print mode; pass --yes to allow unattended local execution' }),
}

export async function runPrint(opts: RunCliOptions): Promise<RunResult> {
  const { args } = opts
  const task = args.prompt
  if (!task) throw new Error('请提供任务，例如: hue -p "修这个 bug"')
  const sessionId = args.session ?? crypto.randomUUID()
  const dbPath = resolve(args.cwd, args.db ?? 'hue.db')
  const traceFile = process.env.HUE_TRACE
  const trace = traceFile ? (e: object) => appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), sessionId, ...e })}\n`) : undefined
  const tel: Telemetry | undefined = process.env.HUE_OTLP
    ? makeTelemetry({ url: process.env.HUE_OTLP, serviceName: 'hue', captureContent: process.env.HUE_OTLP_CONTENT === '1', onError: e => console.error(`[telemetry] ${e.message}`) })
    : undefined

  const { sandbox, workdir, copy } = await makeSandbox(args.sandbox, args.cwd)
  const llm = modelFromEnv({ model: args.model, trace })
  const onEvent = opts.onEvent ?? (args.json ? jsonPrinter() : textPrinter())
  const db = sqliteStore(dbPath)
  const store = tel ? observeStore(db, tel) : db
  const context: ContextStrategy = chain(foldToolResults(), summarize({ model: llm }))
  try {
    if (args.sandbox === 'docker') {
      console.error(`在副本 ${copy} 里工作（docker，镜像 ${process.env.HUE_IMAGE ?? 'node:22'}，网络 ${process.env.HUE_NETWORK ?? 'bridge'}）`)
    }
    const agent = createAgent({
      model: llm,
      store,
      instructions: INSTRUCTIONS,
      tools: codingTools(),
      sandbox,
      policy: opts.policy ?? policyFor(args.sandbox, args.yes),
      context,
      capabilities: capabilities(),
      input: decline,
      maxSteps: 40,
    })
    const result = await drain(agent.run(task, { sessionId, signal: opts.signal }), onEvent)
    console.error(`会话 ${sessionId}${copy ? `（续聊：同一个 id 加 HUE_COPY=${copy}）` : ''}`)
    if (copy) console.error(`看改动：git -C ${copy} diff\n采纳到原仓库：git -C ${copy} diff | git -C ${workdir} apply`)
    return result
  } finally {
    db.close()
    await tel?.shutdown(AbortSignal.timeout(10_000))
    if ('dispose' in sandbox) await (sandbox as { dispose(): Promise<void> }).dispose()
  }
}
