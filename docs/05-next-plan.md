# 05 下一阶段计划（2026-11-12）

## 目标

1. **A. 最核心的 harness**：按原计划做完"自学 + 实现"，13 个包加 cli 在真实任务上站得住，并且我能不看稿讲清每一层。
2. **B. eval + RSI**：一套可复现的评测，加一个"失败 → 假设 → 小改动 → 配对验证 → 采纳或拒绝"的改进循环。任务来源是 GitHub issue / 真实修复 PR 和业界 benchmark，用来持续抬高 Hue 的分数。

这里的 RSI 指 **harness 改进循环**（改 prompt、工具描述、context 参数、skills、policy、harness 代码），不是改模型权重。

## 现状基线（2026-11-12 跑过）

- 13 个包加 cli 都有代码。`npm test`：502 个测试，483 通过，19 skip，0 失败。`npm run budget` 全部在预算内（cli 1324/1400、telemetry 362/400 最紧）。
- **没有一项在真实模型 + 真实仓库上验证过**：阈值、召回、白名单、题目难度、摘要质量都是猜的。
- `npm run check` 已可用（逐包 `tsc -p`，见 ADR-003、ADR-022）；CI 在 GitHub 上已跑绿（PR hifizz/hue#2，修了两个只在 CI 上暴露的测试问题，见 ADR-022）。
- eval：5 道题，无前后对比，无 manifest，无成本，无对照组，不能接外部 benchmark。

## 总判断：A 和 B 不是两条线

缺口清单里大部分"没验证"都卡在"没有数据"。所以顺序是：**先打通真实运行，再搭 eval，再让 eval 的失败分布决定 A 里先补哪个洞**。RSI 循环建在 eval 之上，A 的补洞和 RSI 实验交错进行。

```
M0 地基 → M1 真实验证 → M2 eval v2 → M3 外部/真实任务源 → M4 RSI 循环
                                         ↘ M5 核心补完（由失败分布驱动，与 M2–M4 交错）
M6 对外（博客、简历）持续消费 M1–M4 的数据
```

## M0 地基（1–2 天）

- ~~根目录补 `tsconfig.json`（references 指向各包），`npm run check` 能过。~~ 改为逐包 `tsc -p`，`npm run check` 16 个项目通过（ADR-003）。
- ~~CI（GitHub Actions）：`check` + `test` + `budget`，Node 22。~~ 已写 `.github/workflows/ci.yml`（ADR-022）。
- ~~lint~~ 打开 tsc 严格选项，不引入 ESLint（ADR-022）。
- 合并 `feat/cli`，推送。
- 验收：CI 绿。**已达成**（PR #2 的 `ff9e1ef`）；合并 `feat/cli` 还没做。

## M1 真实验证（2–3 天）= 路线图第 1 周遗留的里程碑

- 选 2–3 个真实仓库的真实 bug（一个自己的项目，一个开源小库的 good-first-issue），用 `hue -p` 或 `examples/agent.ts`，带 `HUE_TRACE`，再用 `examples/replay.ts` 看上下文增长。
- 顺手校准：context 的 80%/50%/6 步阈值、token 估算对 `usage.inputTokens` 的偏差、`coding()` 白名单的误拦。
- 产物：`docs/research/first-real-run.md`（问题清单），挡路的问题当场修。
- 验收：至少 2 个真实 bug 修好，录一段屏。

## M2 eval v2（约 1 周）：RSI 的地基

1. **可复现**：报告 JSON 带 `manifest`（git sha、模型、`HarnessConfig` 哈希、任务集哈希、镜像 digest、trials）。
2. **对比**：`compare a.json b.json`，按任务配对，列出 pass→fail / fail→pass 的翻转，给置信区间（Wilson 或配对 bootstrap），明确标"噪声内"。dev 集 trials ≥ 3。
3. **成本**：价格表算美元，`--max-cost` 超了就停。
4. **任务分层**：`dev` / `heldout` / `regression` 三个集合，划分写进 manifest。heldout 的内容 proposer 读不到。
5. **可调面显式化**：新增 `HarnessConfig`（数据文件，在 recipe 层读，不改 core）：系统提示片段、工具描述覆盖、context 阈值、skills/memory 开关。RSI 的 L1 改动只改这个文件。
6. **题集 5 → 20**，按设计页分类：bug 修复 8、长上下文 3、需要 skill 2、需要 MCP 2、需要记忆（跨两次会话）2、需要子 agent 2、多文件特性 1。后几类才是在测 skills / memory / MCP / 子 agent 这些包。先在真实模型下跑一遍，砍掉太简单或太玄的题。
- 验收：一条命令出带 manifest 的报告；`compare` 在两份报告之间给出翻转和区间。

## M3 外部 benchmark 与真实任务源（约 1.5 周）

三种来源都适配成 `EvalTask`，适配器放在 `hue/bench/`（配方层），不进包，不占行数预算。

| 来源 | 说明 | 要先查清的 |
|---|---|---|
| a. SWE-bench 系（Verified/Lite 子集 20–50 题） | repo@base_commit + issue 文本；隐藏测试，判 FAIL_TO_PASS / PASS_TO_PASS | `TODO(verify)`：官方评测镜像是否有 arm64；在 Mac 上跑 x86 镜像会很慢，大概率要一台 Linux 机 |
| b. Terminal-Bench | 其他 harness（Claude Code / Codex 等）常报的终端任务 | `TODO(verify)`：当前版本和外接 agent 的适配接口 |
| c. 自建 issue 挖掘器 `mine` | 取 closed issue → 关闭它的 PR，PR 含测试改动，测试在父提交失败、合并提交通过。任务 = repo@父提交 + issue 正文，隐藏测试 = PR 的测试文件 | 时间窗口选在模型训练截止之后（2026-06 之后）来避开污染；Hue 自己仓库的 issue 也算（dogfood） |

- 对照组：同模型下 Claude Code `-p`、Pi，只比通过率、耗时、成本（不比 token 和步数，原因见 eval DECISIONS 第 6 条）。
- 验收：SWE-bench 子集 20 题 + 自挖 20 题上有 Hue 的基线数字，至少一个对照组。

## M4 RSI 循环（约 2 周，与 M5 交错）

```
跑 dev（trials≥3）→ 失败聚类（layer + 最后几步）→ 提出 1 个假设 + 1 个最小改动
→ dev 上配对对比 → 超过噪声才跑 heldout → 门禁 → 人批 PR → 写入实验账本
```

- **一次只改一个变量**；改动按风险分级：L1 `HarnessConfig` / 提示 / 参数（门禁过了可以快合）；L2 工具、skill、policy 代码（人审）；L3 core 接口（禁止，走 `CHANGE-REQUEST.md`）。
- **实验账本** `docs/experiments/EXP-NNN.md`：假设、diff、前后数据、判决、花了多少钱。**被拒绝的也记**，防重复，也是博客素材。
- **防自欺（硬规则）**：proposer 不能改 eval 包、任务集、判分命令、门禁脚本、heldout；用路径守卫在 CI 里强制。
- **防过拟合**：heldout 不暴露；采纳条件 = dev 上显著提升 + heldout 不回退 + regression 集不回退；每隔一段时间用 `mine` 补新题。
- **GitHub issue 闭环**：每个失败簇自动开一个 `eval-failure` issue（带会话 id 和摘要）。proposer 领 issue 开 PR，PR 描述里贴 `compare` 结果。
- **proposer 的演进**：先由我 + Claude Code 手动当 proposer，把门禁跑通；再让 Hue 改 Hue。
- 验收：账本里至少 3 个完整实验（含 1 个被拒绝的），其中至少 1 个让 heldout 提升且超过噪声。

## M5 核心补完（A 线，由数据驱动）

**P0（多半会挡住评测）**
- ai：在线跑 `modelPortContract` 的 4 个测试（OpenAI provider 已决定先不做）。
- runtime：子 agent token 汇总进父会话（否则成本统计是错的）。
- sandbox：Linux 验证（benchmark 机器需要）。**部分完成**：GitHub 的 ubuntu runner 上 19 个 docker 用例全部通过；其他发行版、cgroup v1、以及 benchmark 用的云机还没验证。
- context / policy：用 M1、M3 的 trace 调阈值和白名单。

**P1**
- MCP 连一个真实的 HTTP server；拍板 4 个默认值（annotations 是否信任、子进程继承环境变量、连不上 server 是否降级、等用户填表是否计入工具超时）。
- 崩溃后修复子会话里没关的 turn；跨进程会话互斥测试；排队式 steer。

**P2 自学（原计划，"先能跑，再吃透"的第二半）**
- 对着 `learn/` 读 `packages/core/src/loop.ts`，写清多出来的每一块在解决什么。
- 补课：04 工具并发 / 副作用 / 权限，05 上下文压缩，06 持久化与崩溃恢复。每课对应一篇构建日志。
- 检验标准：合上代码能讲清；之后再决定 core 是否有要重写的部分（重写要升 `specVersion`）。

## M6 对外（持续）

构建日志 #1–#4、横评长文、《我为什么要亲手写一个 harness》、简历重写。素材来自 M1 的真实运行、M3 的对比数字和 M4 的实验账本。

## 时间线（单人，粗估）

| 周 | 内容 |
|---|---|
| 1 | M0、M1、M2 前半 |
| 2 | M2 后半、M3a、M5 P0 |
| 3 | M3b/c、基线、对照组 |
| 4–5 | M4，M5 P1/P2 穿插 |
| 6 | 收口、写作、投递 |

## 风险与诚实的限制

- **噪声**：20 题 × 3 trials 只能分辨大幅度的改动（粗估 15–20 个百分点以上），小幅调参看不出来。早期 RSI 的收益大概率来自修 harness 的缺陷，不是微调；要抓小改动就得扩题集，成本线性上涨。
- **成本**：没有数据前不估预算。M1 先测单题成本，再定 `--max-cost`。
- **污染**：SWE-bench 公开多年，模型可能见过；所以要自挖截止日期之后的题。
- **行数预算**：cli 快满了，适配器和脚本放 `hue/bench/`，不要挤进包里。
- **对外说法**：不说"比 Pi / Claude Code 更好"。数字只说"同模型同任务下的位置"。

## 附录：最初缺口清单 → 计划对照

最初清单有五大项。逐条对照后，第一版计划漏了一批；漏的已补进对应里程碑（标 **新增**）。"不做"的写明理由，不算悄悄丢掉。

### 一、gateway / telemetry
| 缺口 | 去处 |
|---|---|
| `examples/gateway.ts` 从没真正启动过；没用浏览器 / 反向代理验证 | **新增** M5 P1：真启动，用 curl + 浏览器走完一次 SSE + 人工批准 |
| telemetry 没对着真实 collector 发过 | **新增** M5 P1：本地起 OTel collector / Jaeger（Docker），看到一条完整 trace |
| WebSocket、具体 IM 平台适配 | 不做（`LATER:`，求职版不需要） |

### 二、各模块缺口
| 模块 | 缺口 | 去处 |
|---|---|---|
| ai | OpenAI 没做 | 不做（已拍板） |
| ai | 在线 `modelPortContract` 4 个测试没跑过 | M5 P0 |
| ai | thinking 签名往返没实测 | **新增** M1：用 `HUE_TRACE` 对着真实模型跑一次多轮 + 工具调用，检查签名原样回传 |
| ai | `HUE_TRACE` 没对着中转站跑过 | M1 |
| context | 摘要质量没测 | M2 长上下文题（3 道）里单独记录触发摘要前后的通过率 |
| context | 阈值是经验值；token 估算没对 `usage.inputTokens` | M1 校准 |
| policy | 白名单没经真实任务验证 | M1 + M5 P0（用 trace 统计误拦） |
| policy | 不是安全边界 | 设计如此，真正边界是 Docker；写进 cli README 的警告里即可 |
| sandbox | 只在 macOS + OrbStack 验证 | M5 P0：Linux |
| sandbox | local 不隔离 | 设计如此 |
| runtime | 排队式 steer；崩溃后修复子会话；跨进程互斥测试 | M5 P1 |
| runtime | 子 agent token 不汇总 | M5 P0 |
| runtime | 真实模型下的子 agent | M2 题集（子 agent ×2） |
| eval | 20 道题 / 对照组 / 前后对比 / 难度没测 | M2、M3 |
| eval | 失败案例分析模板 | **新增** M4：`EXP-NNN.md` 模板里含"现象、哪一层、改了什么、前后数据" |
| eval | 失败分层只是粗略判断 | **新增** M4：拿真实失败人工标注 20 例，对照 `layerOf` 的标签，算准确率，不准就改 |
| skills / memory | 没用真实模型验证；没有"需要 skill / 记忆"的题 | M2 题集（skill ×2、记忆 ×2） |
| memory | 召回质量没量过 | **新增** M2：记忆题里记录召回的命中与误召 |
| memory | 持久化提示注入面 | **新增** M2：一道对抗题（笔记里埋指令），验证 agent 不照做；没通过就改 memory 的缓解措施 |
| tools / MCP | HTTP 真实 server | M5 P1 |
| tools / MCP | 4 个待拍板的默认值 | M5 P1 |
| tools / MCP | MRTR、取消、断流没碰过真实 server；没和官方 SDK 对报文 | **新增** M5 P1：挑一个支持这些的真实 server 手动测；用官方 SDK 对同一 server 抓包对比 |
| store | 基本完整 | 无 |

### 三、真实仓库修真实 bug
M1。

### 四、非代码待办
| 缺口 | 去处 |
|---|---|
| 博客 #1–#4、横评长文、《为什么亲手写》、简历 | M6 |
| monorepo 骨架、CI | M0 |
| lint | **新增** M0：ESLint 或 `tsc --noEmit` 之外的最小规则；如果觉得不值，写 ADR 说明不做 |
| `npm run check` | M0 |

### 五、零碎
| 缺口 | 去处 |
|---|---|
| 本地领先 `origin/main` 未推送 | M0 |
| 98 处 `DECIDE:` / `TODO(deep)` / `TODO(verify)` | **新增** M5 P2：每做完一个里程碑，清掉相关包的标记（拍板→写 ADR 并改成 `DONE(ADR-xxx)`；核实不了的保留） |
| 残留空转的 mock MCP 进程 | **新增** M0：`pgrep -fl mcp-stdio-server` 查并清掉；若测试会留下进程，修测试的清理 |
| `/tmp/magpie-claude-work-65532` 来源 | 不处理：它是上一个会话环境的工作目录，不是本项目的路径 |

## 已拍板（2026-11-12）

| 事项 | 选择 | 影响 |
|---|---|---|
| 外部 benchmark | 先做 SWE-bench 子集 | Terminal-Bench 推到 M3 之后；issue 挖掘器复用同一套机制 |
| 评测机器 | 本地 Mac 跑 dev 集，Linux 云机跑 SWE-bench | M3a 前要先有一台云机 |
| 对照组 | Claude Code + Pi | 各写一个调用适配，只比通过率、耗时、成本 |
| 每月预算 | 约 50 美元 | 见下 |
| OpenAI provider | 先不做 | 从 M5 P0 里删掉；`ModelPort` 可换性暂时只是设计上成立 |
| RSI proposer | 先 Claude Code 手动，机制稳了再让 Hue 改 Hue | M4 前半段人在回路里 |

**50 美元预算的后果**：这是最紧的约束。`--max-cost` 变成 M2 的必做项，不是可选项。M1 先测单题成本，再决定能跑几道 SWE-bench、几次试跑；很可能 SWE-bench 只能跑 10–20 题且 trials=1，Hue 加两个对照组的三方对比要分月做。dev 集优先用便宜的小题。如果测出来单题成本让这个预算连基线都跑不完，要回头改预算或缩范围，而不是悄悄降 trials。
