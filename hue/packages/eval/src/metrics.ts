import type { HueEvent } from '@hue/core'
import type { Metrics, Status } from './types.js'

/** 全部来自事件日志：eval 不碰 agent 的内部，换一个 runner 照样算。 */
export function metricsOf(events: HueEvent[], durationMs: number): Metrics {
  const m: Metrics = { steps: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, toolCalls: 0, toolErrors: 0, denied: 0, compactions: 0, durationMs }
  for (const e of events) {
    if (e.type === 'model.message' && e.finishReason !== 'aborted') {
      m.steps++
      m.inputTokens += e.usage.inputTokens + (e.usage.cacheReadTokens ?? 0) + (e.usage.cacheWriteTokens ?? 0)
      m.cacheReadTokens += e.usage.cacheReadTokens ?? 0
      m.outputTokens += e.usage.outputTokens
    } else if (e.type === 'tool.call') m.toolCalls++
    else if (e.type === 'tool.result') { if (e.isError) m.toolErrors++; if (e.synthetic === 'denied') m.denied++ }
    else if (e.type === 'context.compacted') m.compactions++
    else if (e.type === 'turn.ended') m.endReason = e.reason
  }
  return m
}

/**
 * 没通过时，失败大概发生在哪一层。只是看事件做的粗略判断，不是诊断：
 * 真正的分析要看时间线（examples/replay.ts）。"wrong-result" 的意思是 agent 正常结束了但结果不对，原因这里看不出来。
 */
export function layerOf(status: Status, events: HueEvent[]): string | undefined {
  if (status === 'pass') return undefined
  if (status === 'error') return 'harness'
  if (status === 'timeout') return 'timeout'
  const end = events.findLast(e => e.type === 'turn.ended')
  if (!end || end.type !== 'turn.ended') return 'interrupted'
  switch (end.reason) {
    case 'error': return end.error?.code === 'context_overflow' ? 'context' : 'model'
    case 'stop_condition': return 'step-limit'
    case 'length': return 'output-limit'
    case 'interrupted': return 'interrupted'
    default: {
      const m = metricsOf(events, 0)
      return m.toolCalls >= 4 && m.toolErrors * 2 >= m.toolCalls ? 'tools' : 'wrong-result'
    }
  }
}
