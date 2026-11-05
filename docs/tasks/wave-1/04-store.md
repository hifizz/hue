# 任务：@hue/store —— 事件日志

**预算** 500 行 · **依赖** core · **合同** `eventStoreContract`

## 目标
实现 core 的 `EventStore`。事件日志是 Hue 的唯一事实源（core.md D1），所以这个包小，但正确性要求最高。

## 对外 API
```ts
import { memoryStore, sqliteStore } from '@hue/store'
const s = memoryStore()
const s2 = sqliteStore('./hue.db')          // Node 22 内置 node:sqlite；不可用时报清楚的错
// 额外（非端口，给 runtime / CLI 用）：
listSessions(s2): AsyncIterable<{ sessionId, lastSeq, updatedAt, parent? }>
```

## 必须做到
1. 过 `eventStoreContract` 全部用例：顺序、会话隔离、fromSeq 含端点、seq 必须连续（重复或跳号都拒绝）、拒收 ephemeral 事件、**批量追加原子**、`fold(read())` 可重建。
2. sqlite：一张表 `events(session_id, seq, type, at, body_json, PRIMARY KEY(session_id, seq))`；WAL 模式；批量追加在一个事务里。
3. **崩溃安全**：写入返回之前数据已经落盘（同步提交）。这是 loop "拉取即落盘"保证的另一半。
4. 读取是流式的（大会话不一次性加载到内存）。
5. 存的是事件原样（含 `v`），不存派生的消息快照。

## 你来决定
- 是否存一份派生快照加速大会话启动（建议：先不做，写明会话多大时需要；快照必须可由 fold 重算并校验）。
- 并发写入同一会话的处理（建议：靠主键冲突 + seq 连续性检查拒绝，runtime 保证单写者）。
- 会话分叉（fork）要不要（建议 LATER，只在 DECISIONS 写设计：复制到某个 seq 为止 + session.created.parent）。

## 额外测试
- **kill -9 测试**：子进程边写边被 `SIGKILL`，重启后读出的事件是某个前缀且 seq 连续、无半条记录。这条测试是这个包的招牌，写进 README。
- 10 万条事件的读取不爆内存、追加吞吐量记录到 README。

## 不做
不做记忆语义（memory）、不做消息投影（core 的 fold 已有）。
