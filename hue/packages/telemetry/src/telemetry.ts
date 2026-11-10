import type { EventStore, HueEvent } from '@hue/core'
import { otlpHttp } from './otlp.js'
import type { Exporter, Resource } from './otlp.js'
import { spanBuilder } from './spans.js'
import type { BuilderOptions, Span } from './spans.js'

export interface TelemetryOptions extends BuilderOptions {
  /** 给了 url 就用内置的 OTLP/HTTP JSON 导出器;想换导出方式就给 exporter。二选一。 */
  url?: string
  headers?: Record<string, string>
  exporter?: Exporter
  serviceName?: string
  /** 攒够这么多 span 就发,默认 64。 */
  batchSize?: number
  /** 最长多久发一次,默认 2 秒。 */
  intervalMs?: number
  /** 排队上限,默认 2048。导出器跟不上时丢最老的并计数,绝不让 agent 等它。 */
  maxQueue?: number
  /** 导出失败(重试之后)、丢 span 时通知。默认静默。 */
  onError?: (e: Error) => void
  fetch?: typeof fetch
}

export interface Telemetry {
  /** 喂一个事件。永不抛错、永不阻塞。瞬时事件(delta、progress)直接忽略。 */
  onEvent(e: HueEvent): void
  /** 把已经攒下的(已结束的)span 发完。`endOpen`:把还没结束的 turn / 工具调用也以最后一个事件的时间收尾发出去,标 unfinished——日志已经到头时用。 */
  flush(o?: { signal?: AbortSignal; endOpen?: boolean }): Promise<void>
  /** 收尾(endOpen)、发完、停掉定时器。之后的事件被忽略。 */
  shutdown(signal?: AbortSignal): Promise<void>
  /** 因为队列满而丢掉的 span 数。 */
  readonly dropped: number
}

export function telemetry(o: TelemetryOptions): Telemetry {
  if (!o.exporter && !o.url) throw new Error('telemetry needs either `url` or `exporter`')
  const resource: Resource = { serviceName: o.serviceName ?? 'hue' }
  const exporter = o.exporter ?? otlpHttp({ url: o.url!, headers: o.headers, resource, fetch: o.fetch })
  const builder = spanBuilder(o)
  const batchSize = o.batchSize ?? 64, maxQueue = o.maxQueue ?? 2048
  let queue: Span[] = [], dropped = 0, closed = false, lastAt = Date.now()
  let sending: Promise<void> = Promise.resolve()
  const report = (e: unknown) => { try { o.onError?.(e instanceof Error ? e : new Error(String(e))) } catch { /* 回调自己的错也不能影响 agent */ } }

  const enqueue = (spans: Span[]) => {
    queue.push(...spans)
    if (queue.length > maxQueue) { const n = queue.length - maxQueue; queue = queue.slice(n); dropped += n; report(new Error(`telemetry queue full: dropped ${n} oldest spans`)) }
  }
  // 发送串行:前一批没发完,后一批排在它后面,顺序和重试互不干扰。
  const send = (signal: AbortSignal) => {
    sending = sending.then(async () => {
      while (queue.length) {
        const batch = queue.splice(0, batchSize)
        try { await exporter.export(batch, signal) } catch (e) { report(e) } // 失败的批次不放回去:重试已经在导出器里做过了
      }
    })
    return sending
  }
  const timer = setInterval(() => { if (queue.length) void send(new AbortController().signal) }, o.intervalMs ?? 2000)
  timer.unref()

  async function flush(f: { signal?: AbortSignal; endOpen?: boolean } = {}) {
    if (f.endOpen) enqueue(builder.close(lastAt))
    await send(f.signal ?? new AbortController().signal)
  }
  return {
    onEvent(e) {
      if (closed) return
      try {
        lastAt = e.at
        const done = builder.push(e)
        if (done.length) { enqueue(done); if (queue.length >= batchSize) void send(new AbortController().signal) }
      } catch (err) { report(err) }
    },
    flush,
    async shutdown(signal) { closed = true; clearInterval(timer); await flush({ signal, endOpen: true }) },
    get dropped() { return dropped },
  }
}

/** 把已经在日志里的会话补导出一遍(崩溃后、事后分析)。span ID 由事件决定,重复导出得到的是同样的 span。 */
export async function exportSession(store: EventStore, sessionId: string, t: Telemetry): Promise<number> {
  let n = 0
  for await (const e of store.read(sessionId)) { t.onEvent(e); n++ }
  await t.flush({ endOpen: true })
  return n
}

/**
 * 包住 EventStore:每个事件落盘成功之后再交给 telemetry。runtime 的所有 durable 事件(包括子 agent 会话的)都经过 append,
 * 所以只要把这个 store 交给 createAgent,父子会话就一次收齐;落盘失败的事件不会出现在 trace 里。
 */
export function observeStore(store: EventStore, t: Telemetry): EventStore {
  return {
    specVersion: store.specVersion,
    append: async events => { await store.append(events); for (const e of events) t.onEvent(e) },
    read: (id, o) => store.read(id, o),
    lastSeq: id => store.lastSeq(id),
  }
}
