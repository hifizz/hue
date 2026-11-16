# 首次真实运行（M1）

> 状态：**runbook 已写好，还没有跑过。** 下面“结果”各节是空的，等你跑完填。
> 目标（docs/05-next-plan.md M1）：在真实仓库里修一个真实 bug，带 `HUE_TRACE`，用数据校准 context 阈值、token 估算、`coding()` 白名单，并检验 thinking 签名往返。

## 0. 准备（约 10 分钟）

1. 选一个**有测试、有一个你已经知道怎么复现的 bug** 的仓库，并确认工作区**干净**（docker 模式在 `git clone` 的副本上跑，副本里没有未提交的改动）。
2. 确认 Docker（OrbStack）在跑：`docker info` 能出结果。
3. 先记下这三样，之后填进“结果”：仓库路径 + 提交 sha、bug 的一句话描述、复现命令（例如 `npm test -- foo.test.ts`）。

```bash
cd ~/side/<你的项目> && git status --short && git rev-parse --short HEAD
```

`git status --short` 必须没有输出。

## 1. 第一次运行：单题成本 + trace + 签名往返

`.env.local` 在 `hue/` 下，hue 会自己读，**不要把 key 贴进终端或对话**。

```bash
cd ~/side/hue-project/hue
HUE_TRACE=/tmp/hue-m1-trace.jsonl ./packages/cli/bin/hue.mjs -p --cwd ~/side/<你的项目> --db /tmp/hue-m1.db "<bug 描述 + 复现命令。要求：先复现，再修，改完跑同一条命令确认通过>"
```

- 这是 docker 模式（默认）：在仓库副本里跑，**不会改你的工作目录**。结束时会打印副本路径。
- 输出末尾的 `结束: ... usage=` 就是这一次的总 token。记下来。
- 如果 agent 卡住或循环：`Ctrl-C`。已经落盘的事件还在，下面的分析照样能跑。

跑完先看**它改了什么、对不对**：

```bash
git -C <副本路径> diff
```

## 2. 分析（我可以帮你读，也可以自己跑）

```bash
cd ~/side/hue-project/hue
npx tsx examples/replay.ts /tmp/hue-m1.db                       # 列出会话，拿到会话 id
npx tsx examples/replay.ts /tmp/hue-m1.db <会话id>              # 时间线
npx tsx examples/calibrate.ts /tmp/hue-m1.db <会话id>           # 校准报告
npx tsx examples/check-trace.ts /tmp/hue-m1-trace.jsonl         # 请求体检查
```

每个脚本看什么：

| 输出 | 要回答的问题 | 判定 |
|---|---|---|
| calibrate §1 | token 估算是否**低估**过 | 低估次数 > 0 要认真对待：压缩会来得太晚。比值中位数远大于 1.3，说明 3.5 字符/token 太保守 |
| calibrate §3 | policy 问了哪些 bash 命令 | 被问的无害命令就是白名单要加的；被拒的要看是不是误拦 |
| calibrate §4 | 哪个工具失败最多、最慢 | edit 的“找不到原文”占比（ADR-007 的“何时要改”） |
| calibrate §5 | 缓存命中率 | 命中率很低说明断点或中转站有问题 |
| check-trace §2 | **thinking 签名往返** | “没有出现历史 thinking 块”**不算通过**，要换一个会产生推理并调用工具的任务再跑 |
| check-trace §3 | 缓存断点位置 | 最后一条消息上要有断点；超过 4 个是 bug |
| check-trace §4 | tool_use / tool_result 配对 | 非 0 会被 provider 拒绝 |
| check-trace §1 | 中转站响应头 | 有没有 `x-request-id`、缓存相关头；状态码是否全是 200 |

## 3. 第二次运行：触发压缩（校准 80% / 50% / 6 步）

1M 窗口下一个 bug 修复几乎不会触发压缩。把触发线调小，让它压：

```bash
HUE_CONTEXT_BUDGET=30000 HUE_TRACE=/tmp/hue-m1b-trace.jsonl ./packages/cli/bin/hue.mjs -p --cwd ~/side/<你的项目> --db /tmp/hue-m1b.db "<同一个任务，或另一个 bug>"
```

然后同样跑 `calibrate.ts` / `check-trace.ts`，重点看：

- calibrate §2：压缩触发了几次、前后 token、**压缩后下一步的缓存读取**（压缩会让 prompt cache 失效，ADR-012 的代价）。
- 压缩之后 agent 有没有**忘了任务、重复做已经做过的事**（读时间线，看压缩后的几步）。这是“摘要质量”目前唯一的人工判据。
- 30000 只是一个让它触发的值，不是推荐值；它**不能**用来证明 80% 合适，只能证明机制在真实模型上能跑。

## 4. 想用 local 模式时

仅当你要验证 `coding()` 白名单的误拦：

```bash
./packages/cli/bin/hue.mjs --cwd ~/side/<你的项目> --sandbox local "<任务>"
```

不带 `--yes`，这时命令会停下来问你（交互 TUI）。每一次“问”都是一个白名单候选，也会被 calibrate §3 记录。**注意 local 不隔离**，它直接改你的目录；请先 `git stash` 或在新分支上。

## 5. 录屏

计划验收要求“至少 2 个真实 bug 修好，录一段屏”。用 TUI 模式（去掉 `-p`）录比较直观；录之前确认终端里没有 key。

## 结果（跑完填）

### 运行 1
- 仓库 / sha / bug：
- 命令：
- 结果（修好 / 没修好 / 修错）：
- usage（in / out / cacheRead / cacheWrite）与花费：
- 步数、耗时：
- 我对 diff 的判断：

### 运行 2（压缩）
- `HUE_CONTEXT_BUDGET`：
- 压缩次数、前后 token：
- 压缩后 agent 的行为：

### 运行 E（2026-11-16，挂 pnpm 缓存）
- 仓库 / sha / bug：同 D（thread-chatbot/any-staff，搜索摘要截断 emoji）
- 命令：`HUE_PNPM_CACHE=1 HUE_THINKING=off HUE_TRACE=... hue.mjs -p ...`（docker，node:22）
- 结果：**error**，`stream read failed: terminated`，4 步（同 A/B/C 一类，但这次只交了 2 个 chunk、313 ms 就断）
- usage：in 14385 out 162，cache 全 0
- pnpm 缓存：**挂载生效**（`~/.cache/hue/pnpm-store` 371M）；但这次没跑到装完（`pnpm install` 120 s 超时被杀）
- 我对结果的判断：缓存机制对了，但被中转站掐流和工具 120 s 超时两个问题挡住了，没验证到"第二次跑变快"

### 运行 F（2026-11-16，挂 pnpm 缓存 + 断流放宽 + bash 300s）
- 仓库 / bug：同 D。命令同 E（`HUE_PNPM_CACHE=1 HUE_THINKING=off`），db / trace 换成 `m1f`
- 结果：**stop**，23 步，17/17 测试通过，diff 正确（和 D 等价，略优）
- usage：in 213511 out 5140，cache 全 0；token 估算比值中位 1.22（0.98–6.75）
- 断流：**0 次** stream-error；两个修复都没被实际触发（这次网络好）
- 工具 26 次：最慢 `pnpm install` 121.1s（缓存已有 371M，比 D 的 245s 快约一半，**单次对比**）；一次 cat 134.4s 另有原因；失败 1 次（bash）
- 时间线不再有 D 那种 sleep+tail 轮询（166s），B 的提示词起了作用
- 校准：压缩没触发（最大单步输入约 9.5k token，远没到 80%）；policy 0 问 0 拒（yolo + docker）；缓存命中 0%

### 校准结论
- token 估算偏差（中位 / 最小 / 最大，是否低估）：
- 白名单需要加的命令 / 误拦：
- thinking 签名往返：通过 / 未覆盖 / 失败
- 缓存命中率与断点：
- 中转站有没有改请求（对照 `HUE_TRACE` 里的请求体）：

### 问题清单（挡路的当场修，其余记在这里）
1. **流中断丢掉整个 turn**（运行 A、B 都是 `stream read failed: terminated`，流在响应头之后 70 秒以上被中转站掐断）。已修一部分：`@hue/ai` 在产出任何 chunk 之前断开会静默重发。**没修的部分**：两次失败时模型都已经在输出了（或者在等一个慢响应），所以这次的修复**很可能救不了这两次**；根本问题是中转站对慢流的超时，或需要 core 支持"丢弃重来"。待第三次运行验证。
   - **运行 E（2026-11-16）又撞上了，而且更刺眼**：`chunks=2, ms=313`。313 ms 就断、只交出 2 个 chunk（基本只有 `message_start` / `content_block_start`），说明中转站会连"几乎没开始"的流也掐。现在的规则是"交出任何 chunk 就不重发"，所以 E 依然丢掉整个 turn。**这逼着重新想规则**：交出几个 chunk 时能不能也重发（重复的就这几块，prompt cache 也在）？——未决，见下面第 5 条。
2. **check-trace.ts 假设请求体是对象**，真实 trace 里是 JSON 字符串，首次分析直接崩溃。已修并加回归测试。
3. **agent 花了 5 步才发现容器里没有 `pnpm`**，还用 `npx pnpm` 拉了一个与仓库钉的版本不同的 pnpm（12.18.0 vs 10.32.1）。`corepack pnpm` 能直接用钉的版本（已验证）。是否让系统提示默认知道 `packageManager` 字段，待定。
4. **`glm-5.3-flash` 的 usage 看起来不含系统提示和工具说明**（第 1 步只报 241 个输入 token，请求体里 system+tools 就约 1400 token），所以 token 估算对 usage 的比值（中位 1.49）**不能用来校准 3.5 字符/token**。缓存读写恒为 0。
5. **运行 E（2026-11-16）："chunks=0 才重发"的规则不够**。E 在 `pnpm install` 还在跑的时候挂了：313 ms、只交出 2 个 chunk 就被掐，按现在的规则不重发，整个 turn 丢掉。候选：(a) 交出 chunk 也重发（重复的就这几块）；(b) 交出几个以内也重发（重复成本极小）；(c) core 支持"丢弃重来"。另外 E 的工具调用 `pnpm install` 120 s 超时被杀（挂缓存也救不了第一次下载），也把"工具默认 120 s 对真实安装太短"摆上了台面。**E 顺带确认了 pnpm 缓存挂载生效**：`~/.cache/hue/pnpm-store` 在 E 之后是 371M。

### 对 05-next-plan.md 的影响
- 单题成本 ≈ ____ 美元 → 50 美元预算能跑 ____ 题（据此决定 `--max-cost` 和 M3 的规模）。
