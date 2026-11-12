# 决定记录索引

两层记录：
- **包内** `hue/packages/<包>/DECISIONS.md`：该包的所有取舍，含实现时的小决定。
- **跨包 / 关键决定** `docs/decisions/ADR-*.md`：用 [模板](ADR-000-template.md)，每份对应一个或几个设计页上的 `DECIDE:` 标记。ADR 不重复 DECISIONS 的全部细节，只写问题、候选、决定、代价、怎么验证，并指回 DECISIONS。

> **来源与状态（2026-11-12）**：ADR-001 到 ADR-021 是回填的（ADR-022 是当天新做的决定），内容取自已有的 DECISIONS.md、设计页和代码，没有新增事实；文档里没写理由的地方，ADR 里直接写明。你已读过并确认；ADR-002、003 的理由是你在对话里补充的。已拍板的 `DECIDE:` 标记已在设计页里改成 `DONE(ADR-xxx)`，仍留着的见下表。

## ADR 清单

| ADR | 标题 | 包 | 状态 | 要你确认什么 |
|---|---|---|---|---|
| [001](ADR-001-event-log-source-of-truth.md) | 事件日志是唯一事实源，loop 拉取即落盘 | core | 已接受 | — |
| [002](ADR-002-dependency-direction-and-mcp-placement.md) | 包只依赖 core；MCP 留在 tools | tools | 已接受 | 理由已补：同属"工具"；未评估过独立成包 |
| [003](ADR-003-toolchain.md) | npm workspaces + tsx + node:test + 逐包 tsc | 全仓 | 已接受 | 没比较过 pnpm / tsup / vitest，照任务书规则；Bun 未验证 |
| [004](ADR-004-line-budget.md) | 每包 src/ 行数预算 | 全仓 | 已接受 | cli（1400）和 tools（1600）两处超出"不要调预算"的常规 |
| [005](ADR-005-ai-handwritten-fetch.md) | ai 手写 fetch，不封装 AI SDK | ai | 已接受 | OpenAI 没做，验收"切换两家"未满足 |
| [006](ADR-006-token-counting.md) | token 计数在 context 里近似，偏高 | context / ai | 已接受 | 系数是经验值 |
| [007](ADR-007-edit-exact-string-replace.md) | edit 用精确字符串替换 | tools | 已接受 | — |
| [008](ADR-008-tool-error-format.md) | 工具错误：`isError` + 文本 | core / tools | 已接受 | 连续失败不设上限（已拍板，core/DECISIONS 第 8 条） |
| [009](ADR-009-mcp-version-negotiation-and-fallback.md) | MCP：先 discover，回退 2025-11-25 | tools | 已接受 | — |
| [010](ADR-010-mcp-trust-annotations.md) | MCP annotations 默认信 | tools | 已接受（你选了默认信） | — |
| [011](ADR-011-store-events-only.md) | store 只存事件，不存快照 | store | 已接受 | — |
| [012](ADR-012-compaction-in-log.md) | 压缩结果写回日志 | context | 已接受 | 80% / 50% / 6 步未经真实数据调过 |
| [013](ADR-013-eval-objective-scoring.md) | eval 只用客观判分 | eval | 已接受 | — |
| [014](ADR-014-policy-rules-as-code-not-a-boundary.md) | 规则是 TS 值；分词不是安全边界 | policy | 已接受 | — |
| [015](ADR-015-sandbox-docker-default-network.md) | docker 默认联网 | sandbox | 已接受 | 你的明确决定，请核对措辞 |
| [016](ADR-016-runtime-steer-at-safe-point.md) | steer 在安全点注入 | runtime | 已接受 | — |
| [017](ADR-017-skills-load-skill-tool.md) | skills 用 `load_skill` 工具 | skills | 已接受 | — |
| [018](ADR-018-memory-markdown-explicit-remember.md) | memory 用 markdown + 主动 remember | memory | 已接受 | — |
| [019](ADR-019-gateway-sse-not-websocket.md) | gateway 用 SSE，不做 WebSocket | gateway | 已接受 | — |
| [020](ADR-020-telemetry-handwritten-otlp.md) | telemetry 手写 OTLP，ID 由事件决定 | telemetry | 已接受 | — |
| [021](ADR-021-cli-is-a-recipe.md) | CLI 是配方，不是新的一层 | cli | 已接受 | 发布形态未决 |
| [022](ADR-022-lint-via-strict-tsc-and-ci.md) | lint 用 tsc 严格选项；逐包 `tsc -p`；CI | 全仓 | 已接受 | CI 已在 GitHub 上跑绿（修了 2 个只在 CI 暴露的测试问题） |

core 另有 [`hue/packages/core/DECISIONS.md`](../../hue/packages/core/DECISIONS.md)（此前没有）：D1–D7 摘要加原先未决的四个问题（第 5–8 条，已拍板）。

## `DECIDE:` 标记去向表

清理前 `grep -rn "DECIDE:" docs/` 共 33 处，下表是其中设计页、架构页、目标页上的 22 处。**表里"已决"的现在都已改成 `DONE(ADR-xxx)`（或 `LATER`），行号是清理前的行号。** 仍以 `DECIDE:` 保留的见表尾。

| 标记 | 去向 | 说明 |
|---|---|---|
| ai.md:15 封装 AI SDK 还是 pi-ai | ADR-005 | 已决；03-roadmap.md:7 同一条 |
| ai.md:16 token 计数放哪 | ADR-006 | 已决 |
| context.md:21 压缩写回日志 | ADR-012 | 已决 |
| context.md:23 近似还是 tokenizer | ADR-006 | 已决，设计页写的"字符/4"与实现不同（ASCII 0.3） |
| store.md:18 存事件还是快照 | ADR-011 | 已决 |
| store.md:19 fork 会话 | store DECISIONS 第 3 条 | `LATER`：只设计不实现，不写 ADR |
| tools.md:12、29 edit 格式 | ADR-007 | 已决 |
| tools.md:30 工具错误格式 | ADR-008 | 已决 |
| eval.md:19 评分方式 | ADR-013 | 已决 |
| eval.md:17 对照组（Pi / Claude Code） | eval DECISIONS 第 6 条 | **未决**：要先写适配器把别家输出转成 `HueEvent`，或只比"是否通过"和耗时 |
| deferred.md:5 规则格式 | ADR-014 | 已决（policy 当时被划入"之后做"，现已实现） |
| core.md:197 instructions 能否 turn 内变 | core/DECISIONS.md 第 5 条 | 已决：下个 turn 生效 |
| core.md:198 超窗重试次数 | core/DECISIONS.md 第 6 条 | 已决：每步最多一次 |
| core.md:199 工具结果大小上限 | core/DECISIONS.md 第 7 条 | 已决：runtime 统一兜底，默认 100 KB（已实现） |
| core.md:200 parse 失败的重试 | core/DECISIONS.md 第 8 条 + ADR-008 | 已决：不设上限 |
| 02-architecture.md:31 MCP 单独成包 | ADR-002 | 已决（理由见 ADR） |
| 02-architecture.md:51 配方形态 | ADR-021 | 已决：函数调用；`hue.config.ts` 没做 |
| 02-architecture.md:52 发布形态 | ADR-021 末段 | **未决**：现在 `private`、无构建 |
| 02-architecture.md:62 工具链 | ADR-003 | 已决（理由见 ADR） |
| 00-goal.md:26 行数上限 | ADR-004 | 已决 |

其余 11 处（`docs/README.md` 的说明文字、`01-why-article-outline.md` 的篇幅 / 推荐 / CTA、`application/kit.md` 的投递顺序、`research/teardown-framework.md` 的第 6 家、`05-next-plan.md`、ADR 模板）是文章 / 求职 / 研究方面的选择，不是 harness 设计决定，不写 ADR，清理时保留。

## 没有 `DECIDE:` 标记、但值得记住的决定

这些已经在各包 DECISIONS.md 里，部分有 ADR：docker 默认联网（ADR-015）、steer 注入（ADR-016）、skills / memory 的形态（ADR-017 / 018）、gateway 用 SSE（ADR-019）、telemetry 手写（ADR-020）、cli 是配方（ADR-021）。

没有 ADR、只在 DECISIONS.md 里的：local 沙箱环境变量白名单（sandbox 第 1 条）、docker 用 CLI 而不是 Engine API（第 3 条）、docker 杀进程按环境变量标记（第 5 条）、prompt cache 断点放哪（ai 第 2 条）、store 并发写入（第 2 条）、runtime 谁负责落盘（第 1 条）、子 agent 作为工具（第 6 条）、eval 的 `error` 状态与失败分层、telemetry 的 span 形状和内容导出默认关。需要的话可以补成 ADR，我没有主动补，避免为凑数写没有人读的文件。

## 仍然没有任何地方记录的

- 2026-11-06 的优先级决定（先让一个 agent 跑起来，再回头吃透 core）：写在根目录 `README.md` 和 AGENTS.md，是项目优先级，不是设计决定，没有写 ADR。
- 本文件的状态列是我的判断，不是你的确认。

## 清理后仍留着的 `DECIDE:`（2026-11-12）

| 位置 | 原因 |
|---|---|
| `02-architecture.md:52` 对外发布形态 | 未拍板：现在所有包 `private`、无构建 |
| `packages/eval.md:17` 对照组 | 未拍板：要先写适配器把 Pi / Claude Code 输出转成 `HueEvent` |
| `01-why-article-outline.md`（3 处）、`application/kit.md`、`research/teardown-framework.md` | 文章、求职、研究方面的选择，不是 harness 设计决定 |
| `README.md`、`05-next-plan.md`、`research/harness-comparison.md`、ADR 文件里的引用 | 说明文字，不是待办 |
