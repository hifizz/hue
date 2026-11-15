/** `!command`：经 bash 工具、当前 policy 和 sandbox 执行，不另开本地 shell。 */
import type { InputPort } from '@hue/core'
import { textOf } from './tui/transcript.js'
import type { Recipe } from './recipe.js'

export interface ShellResult {
  /** 要显示在对话里的文字。 */
  text: string
  isError: boolean
  /** 只有真的执行了才有：`$ 命令` 加输出，`!` 会把它拼进下一次提示词。 */
  block?: string
}

export async function runBang(o: { recipe: Recipe, sessionId: string, command: string, ask: InputPort['request'] }): Promise<ShellResult> {
  const { recipe, sessionId, command, ask } = o
  const bash = recipe.tools.find(t => t.name === 'bash')
  if (!bash) return { text: '没有 bash 工具', isError: true }
  const callId = crypto.randomUUID()
  const turnId = `shell-${callId.slice(0, 8)}`
  const ac = new AbortController()
  const input = { command }
  const decision = await recipe.policy.decide({ sessionId, turnId, callId, tool: 'bash', effects: bash.effects, input }, ac.signal)
  if (decision.action === 'deny') return { text: `命令被拒绝：${decision.reason}`, isError: true }
  if (decision.action === 'ask') {
    const res = await ask({ kind: 'approval', prompt: decision.prompt || command, requestId: callId, sessionId, callId }, ac.signal)
    if (res.action !== 'accept') return { text: '命令未批准。', isError: false }
  }
  try {
    const parsed = bash.parse ? bash.parse(input) : input
    const out = await bash.execute(parsed, {
      signal: ac.signal,
      sessionId,
      turnId,
      callId,
      sandbox: recipe.sandbox,
      progress() {},
      requestInput: req => ask({ ...req, requestId: crypto.randomUUID(), sessionId, callId }, ac.signal),
    })
    const block = `$ ${command}\n${textOf(out.content)}`
    return { text: block, isError: !!out.isError, block }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}
