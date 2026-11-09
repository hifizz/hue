/**
 * 第二层：HTTP。出错分类、等多久、要不要重试、怎么被取消。
 *
 * 一个关键边界：重试只发生在"响应开始之前"（拿到 HTTP 状态码之前或就是错误状态码）。
 * 一旦 200 开始流出，delta 已经交给了消费者（UI 已经显示了半句话），这时重试会让文本重复，
 * 所以流中途的错误（比如 overloaded_error 事件）不在这一层重试，而是作为 error 块交给上层。
 */

export interface ApiErrorInfo {
  /** 0 表示根本没拿到响应（网络层失败） */
  status: number
  type?: string
  message: string
  requestId?: string
  retryable: boolean
  code: 'context_overflow' | 'model_error'
  retryAfterMs?: number
}

export class ApiError extends Error {
  constructor(readonly info: ApiErrorInfo) { super(info.message) }
}

// 429 限流、500/504 服务端、529 过载是官方文档点名的瞬时错误；502/503/408 是网关与超时的常见形态。
// 不重试：400（请求本身有问题）、401/403（密钥）、402（账单）、404、413（请求太大）、409（文档要求先解决冲突）。
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529])

export function classifyHttpError(status: number, bodyText: string, headers: Headers, now: () => number = Date.now): ApiErrorInfo {
  let type: string | undefined, msg: string | undefined, requestId: string | undefined
  try {
    // 官方错误体：{ type: 'error', error: { type, message }, request_id }
    const j = JSON.parse(bodyText)
    type = j?.error?.type
    msg = j?.error?.message
    requestId = j?.request_id
  } catch { /* 不是 JSON：中间的网关 / 中转可能返回 HTML，下面兜底 */ }
  msg ??= bodyText.slice(0, 200) || `HTTP ${status}`
  requestId ??= headers.get('request-id') ?? undefined

  // 旧模型超窗是 400。文档页没有给出确切文案，这里按常见措辞匹配，属于启发式。
  // 新模型（4.5 起）超窗不是错误，而是 stop_reason: model_context_window_exceeded（第 2 课已映射）。
  const overflow = status === 400 && /prompt is too long|context window|context length/i.test(msg)
  return {
    status, type, message: `HTTP ${status}${type ? ` ${type}` : ''}: ${msg}${requestId ? ` (request_id ${requestId})` : ''}`,
    requestId, retryable: !overflow && RETRYABLE.has(status), code: overflow ? 'context_overflow' : 'model_error',
    retryAfterMs: parseRetryAfter(headers.get('retry-after'), now),
  }
}

/** retry-after 可以是秒数，也可以是 HTTP 日期。 */
export function parseRetryAfter(v: string | null, now: () => number = Date.now): number | undefined {
  if (v == null) return undefined
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.round(Number(v) * 1000)
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : Math.max(0, t - now())
}

const abortError = () => new DOMException('Aborted', 'AbortError')

/** 可以被取消的 sleep。退避等待期间用户点了"停止"，必须立刻停，而不是睡完再发现。 */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const onAbort = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export interface RetryOptions {
  maxRetries: number
  baseDelayMs?: number
  /** 单次等待上限。服务端要求等得比它还久（比如 retry-after: 600）就不等了，直接报错：交互式 agent 等不起。 */
  maxDelayMs?: number
  // 下面两个可注入，测试里就不用真的等，也不依赖随机数。
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

export async function fetchWithRetry(doFetch: typeof fetch, url: string, init: RequestInit, o: RetryOptions): Promise<Response> {
  const { maxRetries, baseDelayMs = 500, maxDelayMs = 30_000 } = o
  const wait = o.sleep ?? sleep
  const random = o.random ?? Math.random
  const signal = init.signal ?? undefined
  // 指数退避 + 抖动：成倍增长；乘 0.5~1 的随机系数，避免大量客户端在同一时刻一起重试。
  const backoff = (attempt: number) => Math.round(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() / 2))

  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await doFetch(url, init)
    } catch (e) {
      if (signal?.aborted) throw e // 用户取消：原样抛，上层会识别
      if (attempt < maxRetries) { await wait(backoff(attempt), signal); continue }
      throw new ApiError({ status: 0, message: `network error: ${e instanceof Error ? e.message : String(e)}`, retryable: true, code: 'model_error' })
    }
    if (res.ok) return res

    // 失败响应的 body 必须读掉：不读，底层连接不会释放。
    const info = classifyHttpError(res.status, await res.text(), res.headers)
    const delay = info.retryAfterMs ?? backoff(attempt)
    if (info.retryable && attempt < maxRetries && delay <= maxDelayMs) { await wait(delay, signal); continue }
    throw new ApiError(info)
  }
}
