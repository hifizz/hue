# 沙箱证据：首次真实运行里发生了什么，以及它对"要不要换沙箱方案"说明了什么

> 状态：证据记录，不是决定。决定要写成 ADR（候选：用 Anthropic 的 `sandbox-runtime`，或自己写 Seatbelt / bubblewrap，或先挂包缓存）。
> 日期：2026-11-12 至 13。数据来自 M1 的四次真实运行（见 [first-real-run.md](first-real-run.md)）和一个可重跑的探针脚本。
> 约定：**测到的**和**推断的**分开写；没有核实的外部说法标了来源，没有读过源码的写明。

## 0. 先说结论能支撑什么、不能支撑什么

能支撑：
1. Hue 现在的两种沙箱各缺一块：`local` 不隔离文件，`docker` 在真实 bug 修复里把 85% 的工具时间花在重装依赖上。
2. "在真实目录上加操作系统门禁"（Claude Code、Codex 的路线）和 Hue 的需求是对得上的，Hue 没有这一格。
3. 自己写 Seatbelt 规则会踩一个我们已经踩到的坑（符号链接路径），这是"别自己写"的一条实证。

**不能支撑**（不要把它们写进对外文章当结论）：
- "`sandbox-runtime` 比自己写更好"：我们**没有装过它**，没有跑过。
- "Docker 太慢"：测到的慢来自依赖安装，Docker 本身每次命令只多约 50 毫秒。
- 任何关于 Codex CLI、Grok Build、fx 的实现细节：只读了搜索摘要和两个 README 的前半，**没读过源码**。

## 1. 四次真实运行（同一个任务，`glm-5.3-flash`，docker 沙箱）

任务：修一个"搜索摘要截断在 emoji 中间"的真实 bug。仓库 `thread-chatbot/any-staff`，复现命令 `pnpm test:thread-chat:tree-search`，共 17 项测试。

| 运行 | 提示词差异 | 结果 | 步数 | 总耗时 | 工具耗时 | thinking |
|---|---|---|---|---|---|---|
| A | 原始提示词 | **error**：`stream read failed: terminated` | 9 | 294.2s | 139.6s | 开 |
| B | 加了 `corepack pnpm` 与后台安装提示 | **error**：同上 | 5 | 177.9s | 4.2s | 开 |
| C | 同 B，另加"流产出前断开则重发"的修复 | **error**：同上 | 3 | 106.9s | 1.2s | 开 |
| D | 同 B，另设 `HUE_THINKING=off` | **stop**，17 项测试通过 | 18 | 492.7s | 195.0s | **关（0 of 18 请求带 thinking）** |

流断开的细节（来自 trace，`stream-error` 记录只有 C 之后才有）：

| 运行 | 失败的请求 | 响应头到断开 | 断开前已产出 chunk |
|---|---|---|---|
| A | 第 9 个 | 84.2s | 当时未记录 |
| B | 第 5 个 | 70.2s | 当时未记录 |
| C | 第 3 个 | 94.0s | **1827** |
| D | 无断流 | — | — |

D 里最慢的一次模型调用是第 5 步，**65.0 秒到响应头**，随后又生成了 2073 个输出 token，整步 105.7 秒，**完成了**。所以"中转站对单个流有固定的 60 到 94 秒上限"这个早先的推断**不成立**。

要保守的一点：D 只有 **1 次**。"关 thinking 就不断流"没有被证实，可能只是这次网络好。

## 2. 工具时间花在哪（运行 D，21 次工具调用，195.0 秒）

| 项 | 耗时 | 占比 | 说明 |
|---|---|---|---|
| `sleep N; tail` 轮询 | 166.7s | **85%** | agent 在等容器里的 `pnpm install`（共 4 分 5 秒，下载均速约 42 KiB/s） |
| `tsc --noEmit` | 21.9s | 11% | 内存溢出（`Mark-Compact 1019.9`，Node 默认堆约 1 GB），之后 agent 没有重跑类型检查 |
| 5 次测试 | 4.1s | 2% | |
| 读、列、搜、改文件 | 1.3s | 1% | |

模型本身占总耗时的 297.7 秒（约 60%），其中最慢的两步是 105.7s 和 85.4s。

**这说明"慢"主要不是沙箱造成的，是 docker 模式下的副本里没有 `node_modules`。**

## 3. 沙箱探针（可重跑：`sh hue/examples/sandbox-probe.sh`）

四种环境里，同一个"假密钥 + 项目外文件"的探针。macOS，OrbStack。下表是脚本 2026-11-13 的一次完整输出（Docker 的 5 次耗时和内存也来自这一次）。**此前在对话里手动跑过两次同类实验，结论相同；这份文档按脚本输出为准**。

| # | 环境 | 读到环境变量里的密钥 | 读到项目目录外的文件 | 写项目内 | 写项目外 |
|---|---|---|---|---|---|
| 1 | 普通子进程 | **能** | **能** | — | — |
| 2 | Hue `local`（env 白名单） | 不能 | **仍然能** | — | — |
| 3a | Seatbelt，规则写符号链接路径 `/tmp/...` | — | — | **被拒（不该拒）** | 被拒 |
| 3b | Seatbelt，规则写真实路径 `/private/tmp/...` | — | — | 成功 | 被拒 |
| 4 | Docker（只挂载项目目录） | 不能 | **不能**（路径不存在） | — | — |

Docker 额外测量：暖容器里一次 `docker exec` **0.04 到 0.06 秒**（5 次），空闲容器内存 **972 KiB**（上一次测是 1.5 MiB）。

### 3.1 第 3a 行是一个真实的坑，不是实验失误

macOS 的 `/tmp` 是指向 `/private/tmp` 的符号链接，而 Seatbelt 规则按**真实路径**匹配。规则里写 `/tmp/...`，"允许写项目目录"这一条**等于没有匹配上**，合法写入也被挡了。

我自己先踩了这个坑，并且**先给了一个错误的解释**："项目内写入失败是因为我故意把规则写得很严。"这个解释没有验证，是错的。后来对比两种路径才找到真因。这条记进文档，因为它本身就是"自己写 Seatbelt 会遇到什么"的证据：

- 同一个坑还会出现在 `/var` 到 `/private/var`、`~` 展开、项目目录本身是符号链接等地方。
- 它还解释了更早的一件事：用 `npx @modelcontextprotocol/server-filesystem` 读 `/tmp/...` 失败、改成 `/private/tmp/...` 才成功（M1 之前的 MCP 冒烟）。

### 3.2 第 2 行说明 `local` 模式只做了一半

Hue 的 `local`（`packages/sandbox/src/local.ts`）只做环境变量白名单，代码注释自己写明："命令本身仍以你的用户身份运行……（`cd /` 就出去了）"。探针确认：密钥拿不到，项目外的文件仍然读得到。`local` 目前的文件保护只在工具层（`read` / `edit` / `write` 做路径检查），**`bash` 工具不受它约束**。

## 4. 其他项目怎么做（2026-11-15 已在 [sandbox-survey.md](sandbox-survey.md) 里逐个读源码核实，下表保留原始记录，修正见该文 §9）

| 项目 | 说法 | 来源 | 核实程度 |
|---|---|---|---|
| Claude Code | OS 级：macOS Seatbelt，Linux bubblewrap；网络经代理按域名放行；默认关闭，`/sandbox` 开启 | [sandbox-runtime README](https://github.com/anthropics/sandbox-runtime)、[Anthropic 文章](https://www.anthropic.com/research/claude-code-sandboxing) | 读了 README 前约 10 万字符，后 8 万多未读 |
| `sandbox-runtime`（Anthropic） | Apache-2.0；npm 包加 CLI，TypeScript 可直接调用 `SandboxManager.wrapWithSandbox(cmd)`；标为 "Beta Research Preview" | 同上 | 同上；**没有安装、没有运行过** |
| Codex CLI | macOS Seatbelt；Linux ~~Landlock 加 seccomp~~（修正：bwrap+seccomp 为默认，Landlock 仅 legacy 回退）；云端版在 OpenAI 托管的容器里 | 搜索摘要、[Codex 系统卡](https://cdn.openai.com/pdf/97cc5669-7a25-4e63-b15f-5fd5bdc4d149/gpt-5-codex-system-card.pdf) | **已读源码**（sandbox-survey §2） |
| Pi | 内置没有，默认 YOLO；第三方包 `pi-permission-modes` 用 bubblewrap / `sandbox-exec` | [Pi README](https://upd.dev/badlogic/pi-mono/src/commit/a0fa25410765fac7086286bbdce40046194e16f1/packages/coding-agent/README.md) | 搜索摘要 |
| fx（Vercel Labs） | harness 和模型请求在宿主，文件系统与 shell 操作进沙箱，密钥留宿主 | [Vercel 更新日志](https://vercel.com/changelog/fx-harness-adapter-now-separates-host-and-sandbox) | 页面**没有说沙箱是不是它自己实现的**，也没点名提供方 |
| Grok Build | Rust，Apache-2.0；仓库有 sandbox 相关 crate，事件写 `~/.grok/sandbox-events.jsonl` | [仓库](https://github.com/xai-org/grok-build) | **已确认**（sandbox-survey §4：进程级 nono/Landlock/Seatbelt + bwrap bind-over + seccomp；事件文件是调试遗迹，无读取方） |

`sandbox-runtime` 已知的限制（来自它的 README）：要求系统装 `ripgrep`；Linux 还要 `bubblewrap`、`socat`；Ubuntu 24.04 以上需要调整 AppArmor；**Linux 上路径规则只支持字面路径，解析不了的规则会被静默跳过，被跳过的 `denyRead` 等于什么都没隐藏**；读默认允许、写默认拒绝。（2026-11-15 补：minimax-code vendor 的 v0.0.74-mcode.2 已系统性处理静默跳过问题，见 sandbox-survey §5。）

## 5. 这批证据对 ADR 的含义（草案，待你拍板）

候选：

| 候选 | 证据支持 | 证据反对 |
|---|---|---|
| A. 依赖 `sandbox-runtime`，先做 macOS | 1. 真实目录加门禁正是缺的那一格（§3 第 2 行 vs 第 4 行）。2. 自己写会撞 §3.1 的坑，它的 README 说明它已处理一批类似问题（**未验证它处理了符号链接**）。3. 它是 TypeScript 库，适配成 `SandboxPort` 估计百余行（**估计，未做过**） | 1. 预览版，API 会变。2. 要装系统依赖。3. 与 AGENTS.md"能用 Node 内置就不用库"冲突，需要在 README 写理由。4. Linux 上规则静默跳过的行为需要先验证 |
| B. 自己写 Seatbelt（macOS）+ bubblewrap（Linux） | 无外部依赖，完全可控 | §3.1 就是第一个坑；两个平台各一份；工作量大 |
| C. 只给 docker 挂 pnpm 缓存 | 直接解决 §2 里 85% 的时间；改动小 | 没有解决 `local` 的文件隔离缺口（§3 第 2 行） |
| D. 不动 | 零成本 | M1 的校准运行每次都要等几分钟安装 |

A 与 C **不互斥**：C 解决"慢"，A 解决"`local` 不隔离"。

**更新（2026-11-16）**：A 和 C 都已落地为代码。`seatbelt()` 作为第三种 `SandboxPort` 实现加进了 `@hue/sandbox`（`packages/sandbox/src/seatbelt.ts`，决定见该包 DECISIONS.md 第 9 条）；C 以 `HUE_PNPM_CACHE=1` 挂 pnpm store 实现（DECISIONS.md 第 8 条）。这份文档的 §5/§6 保持"当时证据"的原样，不再往前改——候选表里的 "**未验证**" 字样以 §6.1 和 DECISIONS 为准。

## 6. 还需要验证才能下决定（按顺序）

1. ~~装 `sandbox-runtime` 跑同一套探针~~ **已做（2026-11-15），见 §6.1**。
2. ~~测启动开销~~ **已做（2026-11-15），见 §6.1**。
3. 读 Codex 的 `codex-rs` 里沙箱部分，确认能否独立复用。**未做**（`seatbelt()` 已落地后，这条只剩"还有没有更优做法"的参考价值）。
4. 用 C（挂 pnpm 缓存）重跑 M1 的任务，测装依赖从多少秒降到多少秒。**已做一半（2026-11-16）**：运行 F 里 `pnpm install` 121.1s，对比 D 的 245s（245s 是从零下载，F 的 store 里已有 371M）。单次对比、不是同一任务两次干净对照；第二次干净对照（缓存满 → 缓存满）还没跑。
5. **新增**：`seatbelt()` 在真实仓库跑一次（M1 同任务），确认目录内相对符号链接的 `ENOENT` 行为（§6.1）在真实 pnpm / `node_modules` 场景有没有实际影响。

### 6.1 `sandbox-runtime` 验证（2026-11-15，macOS，v0.0.83，Node 24）

环境：一次性目录 `/tmp/hue-srt-verify`，`npm install @anthropic-ai/sandbox-runtime@0.0.83`，Node 24 `node --experimental-strip-types` 直接跑 TypeScript 探针（不用构建）。探针目录形状和 §3 的 `sandbox-probe.sh` 相同。§6 第 1、2 条全部覆盖，另加了 5 条顺手的问题。

**§6 第 1 条（写内 / 写外 / denyRead ~/.ssh / 符号链接路径）的结果：**

| 探针 | 结果 | 和我们手写 Seatbelt 的 §3 对比 |
|---|---|---|
| 写项目内（规则写**真实路径**） | 成功 | 和 3b 一样 |
| 写项目外（`../outside`） | 被拒（`Operation not permitted`） | 和 3b 一样 |
| `denyRead: [~/.ssh]` 后 `ls ~/.ssh` | 被拒 | 达到 §6 第 1 条的要求 |
| 规则写**符号链接路径** `/tmp/...`，写项目内 | **成功** | **§3.1 的坑它没有踩**：它自己把路径解析成真实路径 |
| 规则写符号链接路径 `/tmp/...`，通过**目录内的相对符号链接**（`project/inner-link -> ../link-target`）写 | **失败**，报 `No such file or directory` | **见下面的警告** |

**§6 第 2 条（开销）的结果：** 同一个已初始化的 manager，`wrapWithSandboxArgv('true')` + spawn + 退出，10 次全部 **16–20 ms**；带网络代理（`allowedDomains: ['registry.npmjs.org']`）时 initialize 本身 6 ms（代理进程在 manager 里常驻，`reset()` 时退出），每条命令仍是 17–19 ms，没有额外开销。网络白名单实测：`curl https://registry.npmjs.org/` 返回 200，`curl https://example.com/` 返回 000（连接失败），域名级放行/拦截都生效。

**顺手多问的几条：**

- **环境变量：`wrapWithSandboxArgv` 返回的 `env` 不是增量，是完整的 `process.env` 加它自己的键**（实测把宿主所有变量原样带进去，包括我们设的 `DEMO_API_KEY`、以及 `SSH_AUTH_SOCK`、各种 `*_API_KEY`）。所以"密钥不进子进程"这件事 **sandbox-runtime 不管，调用方还得自己做 env 白名单**——和 Hue 现在 `local` 的做法一样，两者组合才行。
- **读默认允许、写默认拒绝**（README 的说法）实测成立：没配 `denyRead` 时能读项目外文件（`cat outside/secret.txt` 成功）、能读 `/etc/hostname`；没配 `denyWrite` 时写 `/etc` 被拒。
- **相对符号链接不能逃出文件系统边界**：在沙箱里 `ln -s ../../../.. esc` 然后 `cat esc/etc/zshrc`，报 `No such file or directory`。读默认允许，但 Seatbelt 的文件域边界对链接也生效。
- **网络 `allowedDomains: []` 是真的全禁**：`curl https://example.com` 返回 `000`（连接失败），不是 403。
- **没配 `network` 会抛 `TypeError: Cannot read properties of undefined (reading 'parentProxy')`**。`network` 不是可选的，至少传 `{ allowedDomains: [], deniedDomains: [] }`——README 示例里没强调这一点，按最小文件系统配置直接跑会踩到。

**一个实测出的坑（§3.1 之外的第二个符号链接问题，比 §3.1 更隐蔽）：**

`allowWrite` 写 `/tmp/...`（符号链接）它能处理，是因为它把 **allowWrite 里的路径** 解析成真实路径再写进 Seatbelt 规则。但**沙箱运行中访问路径里的符号链接它不管**：`project/inner-link -> ../link-target`，即使 `link-target` 的真实路径就在 `allowWrite` 的目录旁边（甚至在 `allowWrite` 里加上 `link-target` 也不行），通过 `inner-link` 读写都报 `No such file or directory`——而且**这个报错是"文件不存在"，不是"权限拒绝"**，agent 会往"路径错了"的方向查，不会往"被沙箱挡了"的方向查。

对 Hue 的含义：项目目录本身或里面的常见符号链接（`node_modules/.bin`、pnpm 的 store 链接）**可能**受影响。但这条只在一个构造的相对链接上测过，**没有**在真实的 pnpm / node_modules 场景里验证过，可能那些场景走的是绝对路径不受影响。采纳之前要在真实仓库里再跑一次。

**版本事实（和 §4 的 README 记录对照）：** npm 上已是 **0.0.83**，不再标 "Beta Research Preview"（README 里的字样）。包没有 `ripgrep` 这个 npm 依赖，但 `checkDependencies` 仍要求系统装 `rg`（macOS 上 `brew install ripgrep`）；这次探针机器上已有 `rg`，没有单独验证缺它时的行为。

**这一节跑完之后，§5 候选 A 的证据变化（只列新增，原表不动）：**

- 支持：符号链接路径（`allowWrite` 写 `/tmp/...`）**它处理对了**——§3.1 我们手写时踩的坑它没有；每条命令 16–20 ms，比 Hue `local` 的一次 fork 贵不了多少；域名级网络白名单实测生效（npmjs 通、example 断）。
- 反对：**env 不过滤**，调用方还得自己做 env 白名单（和 `local` 现状一样，不是新增工作，但"换上它就什么都有了"不成立）；`network` 字段缺省会抛 `TypeError`；目录内相对符号链接的失败方式是 `ENOENT`（见上），在真实仓库里还没验证。

## 7. 这次过程中犯过的错（作为文章素材，原样记录）

写成文章时，这一节比结论更有价值：

| # | 错误 | 怎么发现的 | 教训 |
|---|---|---|---|
| 1 | 把"流被掐断"解释成"中转站的固定超时" | 运行 D 的第 5 步比被掐断的 94 秒还慢却完成了 | 三个样本时的推断不要写成事实 |
| 2 | `check-trace.ts` 假设 trace 的请求体是对象 | 第一次分析真实 trace 就崩了；真实格式是 JSON 字符串 | 只用构造数据测试的分析脚本，第一次遇到真实数据会坏 |
| 3 | 把 usage"对不上"当成可疑 | 逐步相加后恰好等于总数（177248） | 先验证再怀疑；每步都重发整段历史，总和天然很大 |
| 4 | 一个"不重发"的测试写错了：`ReadableStream` 的 `start` 里先 `enqueue` 再 `error`，会丢掉已入队的数据 | 测试在未改动代码上也失败 | 变异检查要在正常代码上先通过，否则"变异失败"毫无意义 |
| 5 | Seatbelt 项目内写入失败，我先说"规则写得严" | 对比符号链接路径和真实路径 | 没验证的解释不要先说出口 |
| 6 | 重试修复"大概率救不了那两次"——这是对的，但当时没有 `chunks` 数据 | 运行 C 的 `stream-error` 记录：1827 个 chunk 已交出 | 加观测点要早于加修复 |
| 7 | agent 用 `npx pnpm` 拉了和仓库钉的版本不同的 pnpm（12.18.0 对 10.32.1） | 读事件日志 | 容器环境的信息应该能被 agent 默认发现 |

## 8. 数据在哪里（`/tmp` 会被清理，需要时重跑）

- 事件日志与 trace：`/tmp/hue-m1{,b,c,d}.db`、`/tmp/hue-m1{,b,c,d}-trace.jsonl`。**这些不在仓库里**；上面的数字都是 2026-11-13 从它们重新提取的。
- 探针脚本：[`hue/examples/sandbox-probe.sh`](../../hue/examples/sandbox-probe.sh)，可重跑；输出已记在 §3。
- 分析脚本：`hue/examples/replay.ts`、`calibrate.ts`、`check-trace.ts`。
