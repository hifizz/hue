import type { HueEvent } from '@hue/core'
import { HueFault, isDurable } from '@hue/core'

const fault = (message: string) => new HueFault({ code: 'internal', message, source: 'store' })

/**
 * 追加前的校验，memory 和 sqlite 共用，保证两个实现的拒绝规则一致。
 * 只校验、不写：调用方在全部通过之后才落盘，这样一批里有一条不合格，整批都不进去（原子）。
 * seq 必须从 lastSeq+1 开始连续：重复写（重试时容易发生）和跳号（丢了事件）都会让 fold 出错的 state，
 * 所以宁可在写入时就拒绝。
 */
export function checkAppend(events: readonly HueEvent[], lastSeq: (sessionId: string) => number): void {
  const next = new Map<string, number>()
  for (const e of events) {
    if (!isDurable(e)) throw fault(`refusing to store ephemeral event "${e.type}" (session ${e.sessionId})`)
    const want = (next.get(e.sessionId) ?? lastSeq(e.sessionId)) + 1
    if (e.seq !== want) throw fault(`session ${e.sessionId}: expected seq ${want}, got ${e.seq} (duplicate or gap)`)
    next.set(e.sessionId, want)
  }
}

/** 日志里读出来的行坏了（被人手改过、磁盘损坏）：带上位置报错，别让 JSON.parse 的异常无头无尾地冒出去。 */
export function parseRow(sessionId: string, seq: number, body: string): HueEvent {
  try { return JSON.parse(body) as HueEvent } catch { throw fault(`corrupt event body at session ${sessionId} seq ${seq}`) }
}
