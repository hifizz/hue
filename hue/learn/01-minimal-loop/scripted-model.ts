// 按剧本回复的假模型：不需要 API key，行为完全确定，用来看清 loop 本身。
import type { Json, Model, ModelReply, ModelRequest, ToolCallPart } from './loop.js'

export const say = (text: string): ModelReply => ({
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  finishReason: 'stop',
})

export const call = (callId: string, name: string, input: Json): ToolCallPart => ({ type: 'tool-call', callId, name, input })

export const useTools = (text: string, ...calls: ToolCallPart[]): ModelReply => ({
  message: { role: 'assistant', content: [{ type: 'text', text }, ...calls] },
  finishReason: 'tool-calls',
})

/** 返回模型和"它收到过的所有请求"。请求列表可以证明：每个 step 都收到了完整的 messages。 */
export function scriptedModel(script: ModelReply[]): { model: Model; requests: ModelRequest[] } {
  const replies = [...script]
  const requests: ModelRequest[] = []
  const model: Model = {
    async complete(request, signal) {
      signal.throwIfAborted()
      requests.push({ ...request, messages: request.messages.slice() }) // loop 之后还会往 messages 里追加，所以拷贝一份
      const next = replies.shift()
      if (!next) throw new Error('script exhausted: loop called the model more times than scripted')
      return next
    },
  }
  return { model, requests }
}
