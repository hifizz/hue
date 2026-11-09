// 手动跑：node --import tsx packages/store/test/bench.ts   （不是 *.test.ts，npm test 不会跑它）
// 10 万条事件：追加吞吐量（逐条 / 每批 100 条）和流式读取的内存占用。
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HueEvent } from '@hue/core'
import { sqliteStore } from '../src/index.js'

const N = 100_000
const ev = (sid: string, seq: number): HueEvent => ({ v: 1, id: `e${seq}`, sessionId: sid, seq, at: seq, type: 'turn.started', turnId: 't', pad: 'x'.repeat(400) }) as never
const mb = (b: number) => (b / 1048576).toFixed(1)
const dir = mkdtempSync(join(tmpdir(), 'hue-bench-'))

// 逐条提交：每条一次 fsync，是"每个事件都要落盘"的最坏情况（loop 拉取即落盘就是这种用法）
{
  const s = sqliteStore(join(dir, 'single.db')); const n = 2000; const t = performance.now()
  for (let i = 1; i <= n; i++) await s.append([ev('a', i)])
  const sec = (performance.now() - t) / 1000
  console.log(`append 逐条提交 : ${n} 条, ${(n / sec).toFixed(0)} 条/秒 (${(sec / n * 1000).toFixed(2)} ms/条)`); s.close()
}
// 每批 100 条
const path = join(dir, 'batch.db'); const s = sqliteStore(path)
{
  const t = performance.now()
  for (let i = 0; i < N; i += 100) await s.append(Array.from({ length: 100 }, (_, k) => ev('big', i + k + 1)))
  const sec = (performance.now() - t) / 1000
  console.log(`append 每批 100 : ${N} 条, ${(N / sec).toFixed(0)} 条/秒, 用时 ${sec.toFixed(1)}s, 文件 ${mb(statSync(path).size)} MB`)
}
// 流式读取：看 rss 峰值相对基线涨了多少，而不是 heapUsed（后者受 GC 时机影响）
{
  globalThis.gc?.(); const base = process.memoryUsage().rss; let peak = base; let n = 0; const t = performance.now()
  for await (const _ of s.read('big')) { if (++n % 5000 === 0) peak = Math.max(peak, process.memoryUsage().rss) }
  const sec = (performance.now() - t) / 1000
  console.log(`read 全部      : ${n} 条, ${(n / sec).toFixed(0)} 条/秒, rss 涨幅峰值 ${mb(peak - base)} MB（数据本身 ≈ ${mb(statSync(path).size)} MB）`)
}
s.close()
