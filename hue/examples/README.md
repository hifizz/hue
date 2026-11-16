# examples/ — 演示与分析脚本

经 `@hue/runtime` 把各包拼成能改代码的 agent，以及一组"跑完之后从日志 / trace 里读结论"的脚本。这是演示和调研工具，不是产品。

## 跑 agent（要联网、要 key）

| 脚本 | 干什么 | 入口文档 |
|---|---|---|
| [agent.ts](agent.ts) | 把 ai + tools + store + sandbox + policy + context 拼成一个能改代码的 agent。**日常的"跑一个任务"用它**，CLI（`packages/cli`）是它的封装。 | 见下文"agent.ts" |
| [eval.ts](eval.ts) | 把内置 5 个小仓库任务交给 agent 跑，出成功率 / token / 耗时报告。 | 见下文"eval.ts" |
| [gateway.ts](gateway.ts) | 把 agent 放到 HTTP 后面，让别的程序发任务、看事件流、批准工具调用。**只过了类型检查，没真正启动过。** | [packages/gateway/INTEGRATION.md](../packages/gateway/INTEGRATION.md) |
| [mcp-smoke.ts](mcp-smoke.ts) | 连一个真实 MCP server，看协议代、列工具、可选调一个。**MCP client 唯一碰真实 server 的办法。** | 见下文"mcp-smoke.ts" |

## 读结果（只读日志 / trace，不联网、不要 key）

| 脚本 | 输入 | 干什么 | 什么时候用 |
|---|---|---|---|
| [replay.ts](replay.ts) | `hue.db` | 把一个会话打印成时间线：每步模型耗时 / token、工具调用与结果、审批等待、失败。 | 想知道"那次运行每一步发生了什么" |
| [calibrate.ts](calibrate.ts) | `hue.db` | 从事件日志量"经验值准不准"：token 估算 vs 真实、压缩触发、policy 问/拦、工具失败与最慢、花费、缓存命中率。 | M1 校准；改阈值 / 白名单前看数据 |
| [check-trace.ts](check-trace.ts) | `trace.jsonl` | 检查 `HUE_TRACE` 文件：thinking 签名有没有原样往返、缓存断点位置、tool_use/result 配对、请求体增长。 | 怀疑中转站改了请求 / 签名往返出问题 |
| [sandbox-probe.sh](sandbox-probe.sh) | — | 同一组"一个子进程能碰到什么"的探针，在普通子进程 / Hue local / 手写 Seatbelt / Docker 四种环境里各跑一遍。 | 沙箱方案对比的证据来源 |

这四个脚本配两份调研文档，**结论和数据都在文档里，脚本只是产出它们的工具**：

- [docs/research/first-real-run.md](../../docs/research/first-real-run.md) — M1 真实运行记录（A 到 F 各次的结果、断流分析、校准结论、问题清单）。**"为什么改成现在这样"大多在这里。**
- [docs/research/sandbox-evidence.md](../../docs/research/sandbox-evidence.md) — 沙箱方案证据（四种环境探针结果、sandbox-runtime 验证 §6.1、踩过的坑清单 §7）。

## agent.ts

```bash
cd hue
npx tsx --env-file=.env.local examples/agent.ts <仓库目录> "<任务>" [会话id]
```

- 模型默认 `claude-sonnet-5-5`（`HUE_MODEL` 可改），key 和地址读 `AI_GATEWAY_*`。
- 日志写到 `./hue.db`（`HUE_DB` 可改）。上次死在工具执行中途的话，会先补一条 crashed 结果。
- **默认 `HUE_SANDBOX=docker`**：把仓库 `git clone` 到临时目录，容器只挂载这份副本。agent 的 `bash` 在容器里跑，不再逐条确认；原仓库不动。
  - 镜像 `HUE_IMAGE`（默认 `node:22`），网络 `HUE_NETWORK`（默认 `bridge`；`none` 断网）。
  - 副本只含已提交的内容，不含 `node_modules`，需要时 agent 会在容器里装。
  - 跑完打印副本路径和采纳命令：`git -C <副本> diff`、`git -C <副本> diff | git -C <原仓库> apply`。
  - 续聊同一个会话：同一个会话 id，加 `HUE_COPY=<副本路径>` 复用副本。
- `HUE_SANDBOX=local`：不隔离，命令以你的用户身份运行，看一眼和跑测试的命令放行，危险的拒绝，其余停下来问 y/N。要在交互式终端里运行。
- `HUE_TRACE=trace.jsonl`：把实际发给模型的请求体和响应头逐行写进文件（不含 key）。想知道"中转站有没有改系统提示"就靠它，用 [check-trace.ts](check-trace.ts) 读。文件里有完整提示和代码内容，别提交。
- 上下文用 `@hue/context`：`chain(foldToolResults(), summarize({ model }))`，估算超过窗口 80% 就压。长任务里只有折叠真正起作用，见 `packages/context/DECISIONS.md` 第 0 条。
- `HUE_SKILLS=目录[:目录]`、`HUE_MEMORY=目录`：启用 `@hue/skills` / `@hue/memory`（不设就不启用）。技能和笔记在宿主上读写，不经过沙箱；笔记会进系统提示，见 `packages/memory/DECISIONS.md` 第 4 条。
- `HUE_OTLP=http://localhost:4318/v1/traces`：把这次运行导出成 OpenTelemetry GenAI trace（`@hue/telemetry`）；`HUE_OTLP_CONTENT=1` 才带工具参数和结果。退出前等发完（最多 10 秒）。**没对着真实 collector 试过。**
- 策略用 `@hue/policy`：docker 模式 `presets.yolo()`（容器是边界），local 模式 `presets.coding()`（看一眼和跑测试的命令放行、危险的拒绝、其余问你 y/N）。

## eval.ts

```bash
cd hue
npx tsx --env-file=.env.local examples/eval.ts [--tasks fix-off-by-one,add-slugify] [--trials 3] [--concurrency 2] [--out eval-report]
```

把 `@hue/eval` 的 5 个内置任务（小仓库 + 测试）交给 agent，每次试跑一个新的临时目录和执行环境（默认 Docker，`HUE_SANDBOX=local` 不隔离且策略是 `yolo`，只在清楚后果时用）。输出 `eval-report.md` / `.json`：成功率、token、耗时、按任务和标签、失败案例。每次试跑的完整日志在 `HUE_DB`（默认 `./eval.db`），用 `replay.ts` 看。

## mcp-smoke.ts

```bash
cd hue
npx tsx examples/mcp-smoke.ts stdio npx -y @modelcontextprotocol/server-filesystem /some/dir
npx tsx examples/mcp-smoke.ts --call list_directory '{"path":"/some/dir"}' stdio npx -y @modelcontextprotocol/server-filesystem /some/dir
npx tsx examples/mcp-smoke.ts http https://example.com/mcp --header "Authorization: Bearer …"
```

打印对面说哪一代协议（2026-07-28 还是回退到 2025-11-25）、有哪些工具和推断出的 effects，可选地调一个工具；server 要填表时在终端里问你。**这是 `@hue/tools` 的 MCP client 唯一碰真实 server 的办法，还没有人跑过。**

## gateway.ts

```bash
cd hue
HUE_GATEWAY_TOKEN=$(openssl rand -hex 32) npx tsx --env-file=.env.local examples/gateway.ts <仓库目录>
```

把 agent 放到 HTTP 后面（默认 `127.0.0.1:8787`，Docker 沙箱直接挂载 `<仓库目录>`，**改动落在原目录上**）。接口、curl / JS 示例、IM webhook 和部署清单见 [`packages/gateway/INTEGRATION.md`](../packages/gateway/INTEGRATION.md)。**这个脚本只通过了类型检查，还没有真正启动过**；`examples/gateway.test.ts` 用真实 runtime + policy + sqlite 和脚本化模型测了同样的装配。

## 测试

```bash
cd hue
node --import tsx --test examples/*.test.ts      # agent、replay、eval、calibrate、check-trace、capabilities、gateway、telemetry；npm test 不包含它
npx tsc -p examples
```

`agent.test.ts` 用脚本化的假模型跑完整个流程（读 → 改 → 跑测试 → 通过、拒绝执行、越界被拦、崩溃后续写），以及一个跑在 docker 里的用例（没有 Docker 时 skip）。sandbox 本身的测试在 `packages/sandbox/test/`。`calibrate.test.ts` / `check-trace.test.ts` 是离线构造数据的单元测试。

## 没验证的

- **docker 模式用真实模型跑过**：`glm-5.3-flash`（经中转站），在 5 行的演示仓库上 5 到 6 步修好。小样本；`node:22` 镜像是用国内镜像源拉取后打的 tag。
- **local 模式用真实模型跑过两次**，都在 5 行演示仓库上（`claude-sonnet-5-5`）：第一次模型用 `echo > file` 改文件还试图 `cd` 到不存在的目录；系统提示加了"不要 cd"后第二次 4 步用 `edit`。样本太少，不能说明 `edit` 说明已足够。
- **真实仓库真实 bug 跑过**：`glm-5.3-flash` 在 `thread-chatbot/any-staff` 上修好一个"搜索摘要截断 emoji"的 bug（运行 D 和 F）。完整记录见 [docs/research/first-real-run.md](../../docs/research/first-real-run.md)。
- 第二次的第一步模型调用花了 98 秒（只输出 60 token），原因不明，可能是中转站排队。
- 模型说"系统提示里写的工作目录是 /tmp/magpie-claude-work-65532"，而我们的 `INSTRUCTIONS` 里没有这个路径。很可能是中转站或外层往系统提示里加了环境块，未证实，暂不排查。
- 默认联网：容器里的命令能把副本里的内容发出去，副本里有密钥时要用 `HUE_NETWORK=none`。
- 回放查看器只用构造的事件和一份演示会话验证过格式；原始请求要开 `HUE_TRACE` 才有。
