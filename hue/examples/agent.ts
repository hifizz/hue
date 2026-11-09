/**
 * 里程碑脚本：ai + tools + store + core 拼成一个能改代码的 agent（runtime 之前的临时组装）。
 *
 *   cd hue && npx tsx --env-file=.env.local examples/agent.ts <仓库目录> "<任务>" [会话id]
 *
 * 没有 policy 包：bash 等 unsafe 工具每次都会停下来问你 y/n，这是现在唯一的安全措施。
 */
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { emptyState, fold, isDurable, repairDangling, runTurn, userText } from '@hue/core'
import type { HueEvent, InputPort, ModelPort, PolicyPort, SandboxPort, TurnResult } from '@hue/core'
import { model } from '@hue/ai'
import { sqliteStore } from '@hue/store'
import { codingTools } from '@hue/tools'
import { localSandbox } from './local-sandbox.js'

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
    // 没有 policy 包：不可重复的工具（bash）每次都问人。
    const policy: PolicyPort = { specVersion: 'hue.policy.v1', decide: async c => c.effects === 'unsafe' ? { action: 'ask', prompt: `${c.tool} ${JSON.stringify(c.input)}` } : { action: 'allow' } }
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
  // 每个 bash 都要人确认。没有终端（stdin 不是 TTY）时没人能回答，会永远卡在提示上：直接退出并说明。
  if (!process.stdin.isTTY) { console.error('需要在交互式终端里运行：bash 每次都要你输入 y/N 确认，而当前 stdin 不是终端。请在 Terminal 面板里手动输入这条命令。'); process.exit(2) }
  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const result = await runAgent({
    model: model(`anthropic:${process.env.HUE_MODEL ?? 'claude-sonnet-5-5'}`, { apiKey, baseURL: process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL, thinking: { type: 'adaptive', display: 'summarized' } }),
    sandbox: await localSandbox(dir), task, sessionId, db: process.env.HUE_DB ?? './hue.db',
    ask: async p => /^y/i.test(await rl.question(`\n允许执行？ ${p} [y/N] `)), onEvent: printer(),
  })
  rl.close(); console.log(`会话 ${sessionId}（用同一个 id 可以接着聊）`)
  process.exit(result.reason === 'stop' ? 0 : 1)
}
