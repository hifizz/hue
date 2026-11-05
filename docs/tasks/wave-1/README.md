# 第 1 波：6 个并行任务

前提：`@hue/core` 已冻结（v0.2，11 个 loop 测试 + 5 份合同测试）。

| # | 任务 | 包 / 目录 | 预算 | 合同 | 难度 | 必须人审的部分 |
|---|---|---|---|---|---|---|
| 1 | ai | packages/ai | 900 | model | ★★★ | 流式 tool-call 拼装、推理签名往返 |
| 2 | tools 内置 | packages/tools/src/builtin | ~700 | tool | ★★ | edit、输出截断 |
| 3 | tools MCP | packages/tools/src/mcp | ~900 | tool | ★★★★ | MRTR、legacy 回退、断流重发 |
| 4 | store | packages/store | 500 | store | ★★ | kill -9 测试、原子批量追加 |
| 5 | policy | packages/policy | 400 | policy | ★ | bash 分词 |
| 6 | sandbox | packages/sandbox | 600 | sandbox | ★★ | 进程组、路径逃逸、env 隔离 |

## 怎么用
每个 ThreadChat 会话贴：`00-shared-rules.md` + 对应任务文件 + 共享规则里列的上下文文件。

## 合并顺序
互不依赖，谁先过门禁谁先合。建议先合 **store → policy → sandbox**（小、快，能马上和 core 跑通端到端），再合 **ai → tools 内置 → MCP**。

## 门禁（每个 PR）
1. `tsc -b` 全仓零错误
2. 全仓测试通过（含 core 的 11 个，证明没人动 core）
3. `node scripts/budget.mjs` 通过
4. DECISIONS.md 完整
5. 你能脱稿讲清"必须人审"那一栏

## 接口变更流程
任何任务产出 `CHANGE-REQUEST.md` → 你判断 → 若接受：先改 `docs/packages/core.md`，再改 core 代码和合同测试，升 `specVersion`（破坏性时），然后通知所有在跑的任务。一周内 core 最多改一次，攒着一起改。

## 第 1 波完成后的里程碑
store + ai + tools 内置 + sandbox + policy 合起来，就能用一个 30 行脚本跑出第一个能改代码的编码 agent（runtime 之前的临时组装）。这是第一篇构建日志的素材。
