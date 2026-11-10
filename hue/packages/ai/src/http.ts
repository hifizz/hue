/** HTTP 层：一次 POST /v1/messages，只关心三件事——发出去、把字节流接给 SSE、把 HTTP 错误翻译成 ModelChunk。 */

/** 把响应体当成异步字节流。Node 的 web ReadableStream 运行时支持 async iteration，
 * 但 DOM lib 的类型没标注，所以这里显式取迭代器，避免依赖具体 lib 配置。 */
export function bytesFromResponse(res: Response): AsyncIterable<Uint8Array> | undefined {
  const body = res.body
  if (!body) return undefined
  const iterator = (body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  return { [Symbol.asyncIterator]: () => iterator }
}

/** 流还没开始（HTTP 状态码非 2xx）时的错误。错误码用封闭集合里的 model_error，retryable 给上层策略用。 */
export function anthropicHttpError(status: number, bodyText: string): Extract<import('@hue/core').ModelChunk, { type: 'error' }> {
  let detail = bodyText.slice(0, 500)
  try { const j = JSON.parse(bodyText); detail = `${j.error?.type}: ${j.error?.message}` } catch { /* body 不是 JSON：用原文 */ }
  const retryable = status === 429 || status >= 500
  return {
    type: 'error',
    error: { code: 'model_error', message: `anthropic http ${status}: ${detail}`, retryable, source: 'ai:anthropic', data: { status } },
  }
}
