import { isAbort, userText } from '@hue/core'
import type { ContextStrategy, Message, ModelPort, ModelRequest } from '@hue/core'
import { pickCut } from './cut.js'
import { strategy, type BudgetOptions } from './engine.js'
import { textTokens } from './estimate.js'
import { TRUNCATED_NOTE } from './truncate.js'

export interface SummarizeOptions extends BudgetOptions {
  /** 写摘要的模型。可以和 agent 用同一个，也可以换便宜的。 */
  model: ModelPort
  /** 至少保留最近几轮原文，默认 2。刚发生的事摘要最容易写丢细节，所以留原文。 */
  keepTurns?: number
  /** 摘要最长多少 token，默认 1500。同时从目标里预留出这部分空间。 */
  summaryTokens?: number
}

export const SUMMARY_PROMPT = `You are compacting the conversation of a coding agent so that it can keep working after the earlier messages are removed. Write the summary the agent will rely on in their place.

Include:
- the user's goal and any constraints or preferences they stated;
- what has been done so far: files read or changed, commands run, and what they showed;
- the current state, including failing tests and error messages;
- decisions made, and why;
- what remains to be done.

Keep exact identifiers: file paths, function names, commands, error messages, numbers. Do not invent anything that is not in the conversation. If the conversation starts with an earlier summary, merge it into yours instead of repeating it. Be concise; write plain text, no preamble.`

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s)

/** 把要被摘要的消息渲染成一段纯文本。不把 tool-call / 推理块原样发给摘要模型：它没有工具定义，带着 tool_use 块的请求会被 provider 拒绝。 */
export function render(messages: readonly Message[]): string {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === 'user') out.push(`[user]\n${m.content.map(p => (p.type === 'text' ? p.text : `[${p.mediaType} file]`)).join('\n')}`)
    else if (m.role === 'assistant') {
      const parts = m.content.flatMap(p => (p.type === 'text' ? [p.text] : p.type === 'tool-call' ? [`[tool call] ${p.name} ${clip(JSON.stringify(p.input), 500)}`] : []))
      if (parts.length) out.push(`[assistant]\n${parts.join('\n')}`)
    } else {
      for (const r of m.content) {
        const text = r.content.map(c => (c.type === 'text' ? c.text : c.type === 'json' ? JSON.stringify(c.value) : '[file]')).join('\n')
        out.push(`[tool result: ${r.name}${r.isError ? ', error' : ''}]\n${clip(text, 1500)}`)
      }
    }
  }
  return out.join('\n\n')
}

async function ask(model: ModelPort, transcript: string, maxTokens: number, signal: AbortSignal): Promise<string> {
  // 要摘要的内容本身可能比摘要模型的窗口还大：保留靠后的部分（离现在近的更重要），前面标明被截掉了。
  const limit = Math.floor(model.info.contextWindow * 0.7)
  const tokens = textTokens(transcript)
  const body = tokens <= limit ? transcript : `[... the oldest part of the conversation is not shown ...]\n${transcript.slice(-Math.floor(transcript.length * (limit / tokens)))}`
  const request: ModelRequest = { instructions: SUMMARY_PROMPT, messages: [userText(`Conversation to summarize:\n\n${body}`)], tools: [], settings: { maxOutputTokens: maxTokens } }
  let text = '', finished = false
  for await (const c of model.stream(request, signal)) {
    if (c.type === 'text-delta') text += c.text
    else if (c.type === 'finish') finished = true
    else if (c.type === 'error') throw new Error(c.error.message)
  }
  if (!finished) throw new Error('summary stream ended without finish')
  return text.trim()
}

/**
 * 让模型把被丢掉的那部分写成摘要，换进去。信息保留得最多，但要多一次模型调用（延迟和钱），
 * 而且摘要可能漏掉关键细节——所以最近 keepTurns 轮留原文，摘要里要求保留确切的路径和报错。
 * 写摘要失败（报错、空输出）就退回 truncate 的做法，日志里 strategy 会写成 summarize→truncate：
 * 宁可丢信息，也不能让 agent 因为压缩失败而卡死。取消时不压缩，让 loop 自己处理取消。
 */
export function summarize(o: SummarizeOptions): ContextStrategy {
  const summaryTokens = o.summaryTokens ?? 1500
  return strategy('summarize', o, async ({ view, room, signal }) => {
    const cut = pickCut(view, room - summaryTokens, o.keepTurns ?? 2)
    if (cut === undefined) return undefined
    try {
      const text = await ask(o.model, render(view.slice(0, cut)), summaryTokens, signal)
      if (text) return { cut, replacement: [userText(`[Summary of the earlier conversation. It replaces those messages.]\n\n${text}`)] }
    } catch (e) {
      if (signal.aborted || isAbort(e)) return undefined
    }
    return { cut, replacement: [userText(TRUNCATED_NOTE)], strategy: 'summarize→truncate' }
  })
}
