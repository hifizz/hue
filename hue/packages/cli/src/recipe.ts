import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Capability, ContextStrategy, HueEvent, InputPort, ModelPort, PolicyPort, SandboxPort, Tool } from '@hue/core'
import { model } from '@hue/ai'
import { sqliteStore, type SqliteStore } from '@hue/store'
import { observeStore, telemetry as makeTelemetry } from '@hue/telemetry'
import type { Telemetry } from '@hue/telemetry'
import { codingTools } from '@hue/tools'
import { docker, local } from '@hue/sandbox'
import { presets } from '@hue/policy'
import { chain, foldToolResults, summarize } from '@hue/context'
import { file as memoryDir } from '@hue/memory'
import { createAgent } from '@hue/runtime'
import type { Agent, RunResult } from '@hue/runtime'
import { fromDir as skillsDir } from '@hue/skills'
import type { CliArgs, SandboxMode } from './args.js'
import { jsonPrinter, textPrinter } from './print.js'
import { readLastSession } from './session.js'

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

/** 把对象的读写转到 getter，方便 /model 和交互输入在 agent 创建之后再换。 */
export function relay<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const target = get() as Record<PropertyKey, unknown>
      const val = target[prop]
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val
    },
  })
}

export interface RunCliOptions {
  args: CliArgs
  onEvent?: (e: HueEvent) => void
  /** 测试可注入。默认按 sandbox / --yes 选择策略。 */
  policy?: PolicyPort
  input?: InputPort
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

export function policyFor(mode: SandboxMode, yes: boolean): PolicyPort {
  if (mode === 'docker' || yes) return presets.yolo()
  return presets.coding()
}

export const decline: InputPort = {
  request: async () => ({ action: 'decline', reason: 'non-interactive print mode; pass --yes to allow unattended local execution' }),
}

export function gitBranch(cwd: string): string | undefined {
  try {
    const b = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return b || undefined
  } catch { return undefined }
}

export interface Recipe {
  args: CliArgs
  sessionId: string
  workdir: string
  copy?: string
  dbPath: string
  db: SqliteStore
  sandbox: SandboxPort
  policy: PolicyPort
  tools: Tool[]
  getModel: () => ModelPort
  setModel: (name: string) => void
  setInput: (input: InputPort) => void
  agent: Agent
  dispose: () => Promise<void>
}

export async function resolveSessionId(args: CliArgs, db: SqliteStore): Promise<string> {
  if (args.session) return args.session
  if (args.continueLast) {
    const last = readLastSession(args.cwd)
    if (last && await db.lastSeq(last) > 0) return last
  }
  return crypto.randomUUID()
}

export async function openRecipe(opts: RunCliOptions): Promise<Recipe> {
  const { args } = opts
  const dbPath = resolve(args.cwd, args.db ?? 'hue.db')
  const traceFile = process.env.HUE_TRACE
  const tel: Telemetry | undefined = process.env.HUE_OTLP
    ? makeTelemetry({ url: process.env.HUE_OTLP, serviceName: 'hue', captureContent: process.env.HUE_OTLP_CONTENT === '1', onError: e => console.error(`[telemetry] ${e.message}`) })
    : undefined

  const { sandbox, workdir, copy } = await makeSandbox(args.sandbox, args.cwd)
  const db = sqliteStore(dbPath)
  const store = tel ? observeStore(db, tel) : db
  const sessionId = await resolveSessionId(args, db)
  const trace = traceFile ? (e: object) => appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), sessionId, ...e })}\n`) : undefined

  let currentModel = modelFromEnv({ model: args.model, trace })
  let currentInput = opts.input ?? decline
  const policy = opts.policy ?? policyFor(args.sandbox, args.yes)
  const tools = codingTools()
  const context: ContextStrategy = chain(foldToolResults(), summarize({ model: relay(() => currentModel) }))
  const agent = createAgent({
    model: relay(() => currentModel),
    store,
    instructions: INSTRUCTIONS,
    tools,
    sandbox,
    policy,
    context,
    capabilities: capabilities(),
    input: relay(() => currentInput),
    maxSteps: 40,
  })

  return {
    args, sessionId, workdir, copy, dbPath, db, sandbox, policy, tools, agent,
    getModel: () => currentModel,
    setModel: name => { currentModel = modelFromEnv({ model: name, trace }) },
    setInput: input => { currentInput = input },
    dispose: async () => {
      db.close()
      await tel?.shutdown(AbortSignal.timeout(10_000))
      if ('dispose' in sandbox) await (sandbox as { dispose(): Promise<void> }).dispose()
    },
  }
}

export async function drain(agent: Agent, task: string, sessionId: string, onEvent: (e: HueEvent) => void, signal?: AbortSignal): Promise<RunResult> {
  const g = agent.run(task, { sessionId, signal })
  for (let n = await g.next(); ; n = await g.next()) {
    if (n.done) return n.value
    onEvent(n.value)
  }
}

export async function runPrint(opts: RunCliOptions): Promise<RunResult> {
  const { args } = opts
  const task = args.prompt
  if (!task) throw new Error('请提供任务，例如: hue -p "修这个 bug"')
  const recipe = await openRecipe({ ...opts, input: opts.input ?? decline })
  const onEvent = opts.onEvent ?? (args.json ? jsonPrinter() : textPrinter())
  try {
    if (args.sandbox === 'docker') {
      console.error(`在副本 ${recipe.copy} 里工作（docker，镜像 ${process.env.HUE_IMAGE ?? 'node:22'}，网络 ${process.env.HUE_NETWORK ?? 'bridge'}）`)
    }
    const result = await drain(recipe.agent, task, recipe.sessionId, onEvent, opts.signal)
    console.error(`会话 ${recipe.sessionId}${recipe.copy ? `（续聊：同一个 id 加 HUE_COPY=${recipe.copy}）` : ''}`)
    if (recipe.copy) console.error(`看改动：git -C ${recipe.copy} diff\n采纳到原仓库：git -C ${recipe.copy} diff | git -C ${recipe.workdir} apply`)
    return result
  } finally {
    await recipe.dispose()
  }
}
