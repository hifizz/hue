# @hue/runtime 决定记录

## 1. 谁负责落盘？

- **选了**：runtime。`run()` 包住 core 的 `runTurn`，每拉到一个 durable 事件先 `store.append`，再交给调用方。
- **为什么**：core 的 loop 靠"拉取即落盘"保证 tool.call 在工具执行前已在盘上，这个责任必须有人承担，而且每个用 agent 的人都要写一遍同样的循环（`examples/agent.ts` 原来就是）。放进 runtime，调用方拿到事件时它已经在盘上，不用再关心顺序。
- **代价**：每个事件一次 `append`（sqlite 里一次 fsync）。想攒批要改成"工具执行前必须 flush"，现在没做，`store` 的 bench 数据说单次足够快。
- **何时要改**：换成远程 store、单次 append 变成毫秒级之后。

## 2. 运行中用户插话：排队还是注入？

- **选了**：`steer()` 排进队列，在 core 约定的安全点（本步所有工具结果都齐了之后）作为一条 `user.message { steer: true }` 注入同一个 turn。不截断正在输出的模型回复，也不在工具执行中间插入。
- **turn 结束的瞬间才到的插话**：正常结束（`stop`）就接着开一个 turn，不丢。打断 / 出错结束的，原样放进 `RunResult.undelivered` 还给调用方，由调用方决定重发还是丢弃。
- **为什么**：provider 要求 tool-call 和 tool-result 成对相邻，中间不能插 user 消息；只有步与步之间是安全的。
- **代价**：模型正在写一大段回复或一个耗时 10 分钟的 bash 时，插话要等它结束才生效。想立刻生效用 `interrupt()` 再 `run()`。
- **没比较**：Pi 的 steer / queue、Claude Code 的做法没对照过源码，`TODO(verify)`。

## 3. 同一个会话能并发 run 吗？

- **选了**：不能，再 `run` 直接抛错（错误信息指向 `steer()`）。不同会话互不影响。
- **为什么**：两个 turn 同时往一个日志里写，seq 会冲突、transcript 会交错，tool-call 配对就坏了。静默排队会让调用方不知道自己的请求在等谁；要排队的人用 `steer()`。
- **代价**：只在同一个 `Agent` 对象内互斥。**两个进程同时打开同一个会话不会被拦住**，这要靠 store 的 seq 唯一约束（sqlite 里 `(sessionId, seq)` 是主键，第二个写入者会失败）。

## 4. 调用方中途放弃（`return()` / 抛错）

- **选了**：先打断，再把 loop 跑完并落盘（工具收到 aborted 信号，补 interrupted 结果、写 turn.ended），然后才释放会话。
- **为什么**：直接丢掉生成器会留下悬空的 tool.call 和没关的 turn，靠下次 run 的 `repairDangling` 补，虽然也对，但日志里会多一个 `crashed` 的假象，分不清是真崩溃还是调用方走开了。
- **代价**：`return()` 要等工具响应 abort 才返回；工具不理 abort 就一直等到它的超时（`toolTimeoutMs`，默认 120s）。**工具必须处理"信号一开始就已经 aborted"**——放弃 run 时信号在工具启动前就已经被置位。
- 写盘本身坏了（磁盘满）时善后的写入也会失败，吞掉，原错误照常抛给调用方。

## 5. 恢复

- **选了**：每次 `run` 开始都从 store 重建状态，补 `repairDangling` 的结果，再开新 turn。不缓存状态。
- **为什么**：日志是唯一事实源，缓存就多一份可能错的状态。重建是 O(日志长度)，会话很长时每次 run 都读一遍。
- **何时要改**：长会话读日志成为瓶颈时，用 `read(sessionId, { fromSeq })` 加快照。

## 6. 子 agent

- **选了**：作为一个普通 `Tool`（`subagentTool({ agent })`）暴露给父 agent。子 agent 是另一个 `createAgent`（自己的模型、工具、指令），每次调用开一个**新会话**，和父共用同一个 store；`session.created.parent` 记着父会话的 `sessionId / turnId / callId`，事件树就是几个会话用 `parent` 连起来。父的 `tool.result.data.sessionId` 指向子会话。
- **上下文隔离**：子只看到 `task` 字符串，看不到父的历史；父只看到子的最后一条回复，中间过程不进父的上下文（但在日志里，回放看得到）。代价：任务描述必须自包含，写得差子 agent 就瞎做。
- **并发**：靠工具的 `effects`，不另造机制。默认 `unsafe`（串行、policy 会问）；子 agent 的工具全是只读时调用方设 `effects: 'none'`，core 的调度器就会把同一步里派的多个子 agent 并发跑。`maxConcurrent`（默认 4）再限一道，多出来的排队，排队中也能被打断。
- **能否递归**（原 `DECIDE`）：能不能由构造决定——子 agent 的配置里没放 `subagentTool` 就不能再派。没有深度计数器。要允许递归的人自己传，但没有任何上限保护。
- **打断**：父的信号传给子，父被打断时子一起收到 abort，补齐自己的日志。
- **子失败**：返回 `isError` 的工具结果（带原因和它最后说的话），父自己决定重试还是放弃，不让整个父 turn 失败。
- **没做**：子 agent 的 token 用量不汇总进父的 `usage`（只在 `tool.result.data.usage` 里）；父进程崩溃时，子会话里没关的 turn 要等有人 `run` 那个子会话才会修复（子会话 id 是随机的，实际上没人会去）——日志里会留一个没有 `turn.ended` 的子 turn。

## 7. 工具结果大小：runtime 兜底，core 不管

- **选了**：`createAgent` 把所有工具（含 `capabilities` 带来的）的结果文本合计限制在 `maxToolOutputBytes`（默认 100 KB，`Infinity` 关闭），超出保留头尾、写明省略字节数。只限发给模型的 `text` / `json`，不动 `data`、文件块和 `isError`。
- **为什么**：见 core DECISIONS 第 7 条。runtime 是唯一知道所有工具的地方，core 已冻结。
- **代价**：写进日志的 `tool.result` 也是截过的，日志里没有完整原文；100 KB 约 25k token，默认值没调过；绕过 runtime 直接用 `runTurn` 的人没有这一道。
- **何时要改**：有真实数据后调默认值；需要完整原文落盘时。

## 8. 其他

| 决定 | 原因 |
|---|---|
| 新会话以 `session.created` 开头，补写的事件也交给调用方 | UI 要看到全部落盘的事件；子 agent 靠它记录 `parent`（见子 agent 一节）。 |
| `RunResult.usage` / `steps` 是本次 run 里所有 turn 之和 | 用户只调了一次 `run`，不该只看到最后那个 turn 的用量。 |
| runtime 不 import `@hue/store` 等包 | 组装发生在调用方（配方）里，runtime 只认 core 的端口。 |
