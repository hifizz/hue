/**
 * 里程碑脚本：ai + tools + store + core 拼成一个能改代码的 agent（runtime 之前的临时组装）。
 *
 *   cd hue && npx tsx --env-file=.env.local examples/agent.ts <仓库目录> "<任务>" [会话id]
 *
 * 默认在 Docker 容器里、仓库的一份克隆上运行（HUE_SANDBOX=docker），策略 presets.yolo()：容器就是边界。
 * HUE_SANDBOX=local 不隔离，策略 presets.coding()：看一眼和跑测试的命令放行，危险的拒绝，其余问你 y/n。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { emptyState, fold, isDurable, repairDangling, runTurn, userText } from '@hue/core'
import type { HueEvent, InputPort, ModelPort, PolicyPort, SandboxPort, TurnResult } from '@hue/core'
import { model } from '@hue/ai'
import { sqliteStore } from '@hue/store'
import { codingTools } from '@hue/tools'
import { docker, local } from '@hue/sandbox'
import { presets, rules } from '@hue/policy'

const INSTRUCTIONS = `You are a coding agent working in the current directory (a git repository).
Every tool and shell command already runs in the repository root: use relative paths and never cd to another directory.
Find the cause before changing anything: read the code and run the tests. Make the smallest change that fixes the problem, then re-run the tests to confirm. Say what you changed and why.`

export interface AgentOptions {
  model: ModelPort
  sandbox: SandboxPort
  task: string
  db: string
  sessionId: string
  /** 问用户 y/n。测试里换成自动应答。 */
  ask: (prompt: string) => Promise<boolean>
  /** 默认：不可重复的工具（bash）每次都问，其余放行。docker 里用 presets.yolo()，local 用 presets.coding()。 */
  policy?: PolicyPort
  onEvent?: (e: HueEvent) => void
  signal?: AbortSignal
}

export async function runAgent(o: AgentOptions): Promise<TurnResult> {
  const store = sqliteStore(o.db)
  try {
    const load = async () => { const events: HueEvent[] = []; for await (const e of store.read(o.sessionId)) events.push(e); return fold(o.sessionId, events) }
    let state = await load()
    // 上次进程死在工具执行中途：补上"崩溃"结果，否则下一次请求里 tool-call 没有配对的 tool-result，provider 会拒绝。
    const repairs = repairDangling(state)
    if (repairs.length) {
      const events = repairs.map((r, i) => ({ v: 1, id: crypto.randomUUID(), sessionId: o.sessionId, seq: state.lastSeq + 1 + i, at: Date.now(), ...r }) as HueEvent)
      await store.append(events); state = await load()
    }
    const policy = o.policy ?? rules([{ effects: 'unsafe', action: 'ask' }], { default: 'allow' })
    const inputPort: InputPort = { request: async r => (await o.ask(r.prompt)) ? { action: 'accept' } : { action: 'decline', reason: 'the user declined' } }

    const turn = runTurn({ sessionId: o.sessionId, state, input: userText(o.task), model: o.model, instructions: INSTRUCTIONS, tools: codingTools(), sandbox: o.sandbox, policy, inputPort, maxSteps: 40, signal: o.signal })
    for (let n = await turn.next(); ; n = await turn.next()) {
      if (n.done) return n.value
      if (isDurable(n.value)) await store.append([n.value]) // 拉取即落盘：下一次 next() 之前先写，tool.call 在工具执行前就已经在盘上
      o.onEvent?.(n.value)
    }
  } finally { store.close() }
}

/** 终端输出：流式文本 + 每个工具调用一行。 */
export function printer(out: (s: string) => void = s => process.stdout.write(s)): (e: HueEvent) => void {
  return e => {
    if (e.type === 'model.delta') out(e.kind === 'text' ? e.delta : '')
    else if (e.type === 'tool.call') out(`\n▶ ${e.name} ${JSON.stringify(e.input).slice(0, 200)}\n`)
    else if (e.type === 'tool.result' && e.isError) out(`  ✗ ${e.content.map(c => (c.type === 'text' ? c.text : '')).join('').slice(0, 200)}\n`)
    else if (e.type === 'turn.ended') out(`\n\n结束: ${e.reason}，${e.steps} 步，usage=${JSON.stringify(e.usage)}${e.error ? `，${e.error.message}` : ''}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, task, sessionId = crypto.randomUUID()] = process.argv.slice(2)
  if (!dir || !task) { console.error('用法: npx tsx --env-file=.env.local examples/agent.ts <仓库目录> "<任务>" [会话id]'); process.exit(2) }
  const mode = process.env.HUE_SANDBOX ?? 'docker' // docker | local
  if (mode !== 'docker' && mode !== 'local') { console.error(`HUE_SANDBOX 只能是 docker 或 local，收到 "${mode}"`); process.exit(2) }
  // local 模式每个 bash 都要人确认。没有终端（stdin 不是 TTY）时没人能回答，会永远卡在提示上：直接退出并说明。
  if (mode === 'local' && !process.stdin.isTTY) { console.error('local 模式需要交互式终端：bash 每次都要你输入 y/N 确认，而当前 stdin 不是终端。请在 Terminal 面板里手动输入这条命令。'); process.exit(2) }

  // docker 模式在仓库的一份克隆上干活，原仓库不动：agent 改坏了也只坏在副本里，你看完 diff 再决定采纳。
  // 克隆只含已提交的内容；node_modules 不带（宿主的二进制依赖在 Linux 容器里跑不了），需要时让 agent 在容器里装。
  let workdir = dir
  if (mode === 'docker') {
    if (process.env.HUE_COPY) workdir = process.env.HUE_COPY // 续聊：复用上次的副本
    else {
      const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain']).toString().trim()
      if (dirty) console.warn('⚠ 原仓库有未提交的改动，副本里没有它们（副本是 git clone）。')
      workdir = mkdtempSync(join(tmpdir(), 'hue-work-'))
      execFileSync('git', ['clone', '-q', '--no-hardlinks', dir, workdir])
    }
    console.log(`在副本 ${workdir} 里工作（docker，镜像 ${process.env.HUE_IMAGE ?? 'node:22'}，网络 ${process.env.HUE_NETWORK ?? 'bridge'}）`)
  }
  const sandbox = mode === 'docker' ? await docker({ mount: workdir, image: process.env.HUE_IMAGE, network: process.env.HUE_NETWORK }) : await local({ root: workdir })

  // HUE_TRACE=文件：把实际发给 provider 的请求体和响应头逐行写进去（JSONL，不含 key）。排查"模型到底收到了什么"用。
  const traceFile = process.env.HUE_TRACE
  const trace = traceFile ? (e: object) => appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), sessionId, ...e })}\n`) : undefined
  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let result
  try {
    result = await runAgent({
      model: model(`anthropic:${process.env.HUE_MODEL ?? 'claude-sonnet-5-5'}`, { apiKey, baseURL: process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL, thinking: { type: 'adaptive', display: 'summarized' }, trace }),
      sandbox, task, sessionId, db: process.env.HUE_DB ?? './hue.db',
      policy: mode === 'docker' ? presets.yolo() : presets.coding(), // 容器是边界，不再逐条确认；local 没有隔离，按预设放行 / 拒绝 / 询问
      ask: async p => /^y/i.test(await rl.question(`\n${p} [y/N] `)), onEvent: printer(),
    })
  } finally { rl.close(); if ('dispose' in sandbox) await (sandbox as { dispose(): Promise<void> }).dispose() }
  console.log(`会话 ${sessionId}（续聊：同一个 id${mode === 'docker' ? ` 加 HUE_COPY=${workdir}` : ''}）`)
  if (mode === 'docker') console.log(`看改动：git -C ${workdir} diff\n采纳到原仓库：git -C ${workdir} diff | git -C ${dir} apply`)
  process.exit(result.reason === 'stop' ? 0 : 1)
}
