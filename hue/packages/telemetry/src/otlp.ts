import type { Attr, Span } from './spans.js'

export interface Resource { serviceName: string; serviceVersion?: string; attributes?: Record<string, Attr> }

const value = (v: Attr): Record<string, unknown> =>
  typeof v === 'string' ? { stringValue: v }
  : typeof v === 'boolean' ? { boolValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(x => ({ stringValue: x })) } }
  : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } // OTLP JSON:64 位整数是十进制字符串
const attrs = (a: Record<string, Attr>) => Object.entries(a).map(([key, v]) => ({ key, value: value(v) }))
const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n)

/** span → OTLP/HTTP JSON 的 ExportTraceServiceRequest。枚举用整数(规范:不能用名字),ID 是十六进制串,时间是纳秒字符串。 */
export function toOtlp(spans: Span[], r: Resource, scope = { name: '@hue/telemetry', version: '0.0.0' }) {
  return {
    resourceSpans: [{
      resource: { attributes: attrs({ 'service.name': r.serviceName, ...(r.serviceVersion && { 'service.version': r.serviceVersion }), ...r.attributes }) },
      scopeSpans: [{
        scope,
        spans: spans.map(s => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId && { parentSpanId: s.parentSpanId }), name: s.name,
          kind: s.kind === 'client' ? 3 : 1, // SPAN_KIND_CLIENT = 3,INTERNAL = 1
          startTimeUnixNano: nanos(s.startMs), endTimeUnixNano: nanos(s.endMs), attributes: attrs(s.attributes),
          events: s.events.map(e => ({ timeUnixNano: nanos(e.atMs), name: e.name, attributes: attrs(e.attributes) })),
          status: s.error ? { code: 2, ...(s.error.message && { message: s.error.message.slice(0, 256) }) } : { code: 0 }, // STATUS_CODE_ERROR = 2
        })),
      }],
    }],
  }
}

export interface Exporter { export(spans: Span[], signal: AbortSignal): Promise<void> }

export interface OtlpHttpOptions {
  /** 完整地址,例如 http://localhost:4318/v1/traces。 */
  url: string
  resource: Resource
  headers?: Record<string, string>
  fetch?: typeof fetch
  /** 最多尝试几次(含第一次),默认 4。 */
  attempts?: number
  /** 每次请求的超时,默认 10 秒。 */
  timeoutMs?: number
  /** 可注入,测试用。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const RETRYABLE = new Set([429, 502, 503, 504])
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason) // 已经取消的信号不会再触发 abort 事件,不检查就会傻等满 ms
  const t = setTimeout(resolve, ms); t.unref()
  signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
})

/** Retry-After 只认秒数(规范允许日期格式,这里不解析,退回指数退避)。 */
const retryAfterMs = (h: string | null) => (h && /^\d+$/.test(h) ? Math.min(Number(h) * 1000, 60_000) : undefined)

/**
 * OTLP/HTTP JSON 导出器。重试规则照 OTLP 规范:429 / 502 / 503 / 504 和连接失败重试(指数退避加抖动,有 Retry-After 就听它的);
 * 其它 4xx / 5xx(包括 400)不重试;200 带 partial_success 也不重试——重发只会重复已经收下的那部分。
 */
export function otlpHttp(o: OtlpHttpOptions): Exporter {
  const doFetch = o.fetch ?? fetch, sleep = o.sleep ?? wait, attempts = o.attempts ?? 4
  return {
    async export(spans, signal) {
      if (!spans.length) return
      const body = JSON.stringify(toOtlp(spans, o.resource))
      for (let n = 1; ; n++) {
        let delay: number | undefined, failure: string
        try {
          const res = await doFetch(o.url, { method: 'POST', headers: { 'content-type': 'application/json', ...o.headers }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 10_000)]) })
          const text = await res.text().catch(() => '')
          if (res.ok) {
            const rejected = (() => { try { return Number(JSON.parse(text)?.partialSuccess?.rejectedSpans ?? 0) } catch { return 0 } })()
            if (rejected) throw new Error(`collector rejected ${rejected} of ${spans.length} spans`)
            return
          }
          if (!RETRYABLE.has(res.status)) throw new Error(`collector answered HTTP ${res.status}: ${text.slice(0, 200)}`)
          delay = retryAfterMs(res.headers.get('retry-after')); failure = `HTTP ${res.status}`
        } catch (e) {
          if (signal.aborted) throw e
          // 上面主动抛的(不可重试的状态码、部分成功)带 collector 字样;其余是连接层的失败,可以重试。
          if (e instanceof Error && e.message.startsWith('collector')) throw e
          failure = (e as Error).message
        }
        if (n >= attempts) throw new Error(`gave up after ${n} attempts: ${failure}`)
        await sleep(delay ?? Math.min(250 * 2 ** (n - 1), 5000) * (0.5 + Math.random() / 2), signal)
      }
    },
  }
}
