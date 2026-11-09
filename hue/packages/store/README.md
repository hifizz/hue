# @hue/store

事件日志：core 的 `EventStore` 的两个实现，内存版和 SQLite 版（Node 内置 `node:sqlite`，零依赖）。

```ts
import { sqliteStore, listSessions } from '@hue/store'
import { fold, isDurable, runTurn } from '@hue/core'

const store = sqliteStore('./hue.db')
const state = fold(sessionId, await Array.fromAsync(store.read(sessionId)))   // 续写：从日志重建
const turn = runTurn({ sessionId, state, /* … */ })
for (let n = await turn.next(); !n.done; n = await turn.next()) {
  if (isDurable(n.value)) await store.append([n.value])           // 拉取即落盘：下一次 next() 之前先写
}
for await (const s of listSessions(store)) console.log(s.sessionId, s.lastSeq)
```

`memoryStore()` 用法相同，给测试和一次性脚本。`sqliteStore(':memory:')` 也可以。

## 保证

- **顺序**：`seq` 必须从 `lastSeq + 1` 连续；重复和跳号都拒绝。
- **只收 durable 事件**：`model.delta` 这类临时事件被拒绝。
- **批量追加原子**：一批里有一条不合格，整批都不进去（跨会话的批次也是）。
- **落盘后才返回**：事务 + WAL + `synchronous=FULL`。
- **流式读取**：每次取 500 行，大会话不一次性进内存。
- **原样存放**：事件含 `v` 和未知字段原样进出，不存派生的消息快照。

## kill -9 测试

`test/store.test.ts` 里的招牌测试：子进程边写边被 `SIGKILL`（批大小 1、7、50 各一轮），重启后检查：

1. 读到的事件 `seq` 连续、没有半条；
2. **子进程已经确认的每一条都在**（它每次 `append` 返回后才报告一个 seq）；
3. 总数是批大小的整数倍（没有半个批次）；
4. 重启后可以接着往下写。

## 数字（10 万条，每条约 500 字节，本机 macOS，`node --import tsx packages/store/test/bench.ts`）

| | |
|---|---|
| 追加，每批 100 条 | 约 17.5 万条/秒（10 万条 0.6 秒），文件 54 MB |
| 追加，逐条提交 | 约 1.2 万条/秒（0.08 ms/条）——"每个事件都落盘"的用法 |
| 顺序读全部 | 约 60 万条/秒，rss 涨幅峰值 23 MB（数据 54 MB） |

只是一次本机运行，不是基准测试。

## 测试

```bash
cd hue
npx tsc -p packages/store
node --import tsx --test packages/store/test/store.test.ts   # 32 个；npm test 也会跑
```

两个实现都过 core 的 `eventStoreContract`，另有与真 core `runTurn` 配合的测试（边拉边写，`fold(read())` 等于 turn 的 state）。

## 没验证的

- **macOS 上的"落盘"不一定真落到盘**：macOS 的 `fsync` 不保证数据离开磁盘缓存，要 `PRAGMA fullfsync = ON`（会慢很多）。逐条提交 0.08 ms 说明这里没有真正刷盘。kill -9（进程崩溃）不受影响——数据已经交给了操作系统；**断电**才有风险。没有测过断电。
- **kill -9 测试对"半个批次"的检测是概率性的**：去掉事务的变异有时一轮就被抓到，有时抓不到（回滚测试是确定性地抓到）。
- 只在一台机器、一个文件系统上跑过；没测网络盘（SQLite 在 NFS 上不可靠）。
- 没有 fork、没有快照，设计见 [DECISIONS.md](DECISIONS.md)。
- 没有接过真实的 runtime（还不存在）。
