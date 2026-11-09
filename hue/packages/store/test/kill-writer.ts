// 被 store.test.ts 当子进程跑，然后被 SIGKILL。
// 每次 append 返回后才往 stdout 写一行"已确认的 seq"：父进程据此知道"至少有多少条必须在"。
import { sqliteStore } from '../src/index.js'

const [path, batchArg] = process.argv.slice(2)
const batch = Number(batchArg)
const s = sqliteStore(path!)
let seq = 0
while (true) {
  const events = Array.from({ length: batch }, () => ({ v: 1, id: `e${++seq}`, sessionId: 'k', seq, at: seq, type: 'turn.started', turnId: 't', pad: 'x'.repeat(200) }))
  await s.append(events as never)
  process.stdout.write(`${seq}\n`) // 到这里 append 已经返回：这 seq 条必须已经落盘
}
