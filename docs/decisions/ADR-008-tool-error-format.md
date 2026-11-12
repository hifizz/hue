# ADR-008 工具错误回传给模型：`isError` + 文本，参数不合法也走这条路
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/core、@hue/tools
- 来源标记：`DECIDE: 工具错误回传给模型的格式（isError + 文本？结构化？）`（docs/packages/tools.md:30）；相关 `DECIDE: parse 失败的重试`（docs/packages/core.md:200，仍开着）

## 问题
工具失败时，模型看到什么？输入不合法算失败吗？

## 候选
1. `tool.result` 带 `isError: true` 和文本内容，模型读文本。
2. 结构化错误对象给模型。
3. 工具抛错，loop 直接结束 turn。

## 各家怎么做（附出处）
没有核实过。

## 决定
选 1。
- `ToolOutput` 有 `content`（给模型）、`isError`、`data`（不发给模型，给 UI / 回放用）。loop 把它们原样写进 `tool.result` 事件（`core/src/loop.ts:254`）。
- `parse` 失败：生成一条 `isError` 结果，文本是 `Invalid input for <工具>: <原因>`，事件上带 `error.code = 'invalid_tool_input'`（`loop.ts:215-217`），由模型读到后自己重试。
- 搜索无匹配不是错误；正则写错才是（tools DECISIONS 第 4 条）。
- 未知参数也拒绝，错误信息写明期望的参数名，因为模型常把 `path` 写成 `file_path`。
- 对 MCP：工具返回的错误作为 `isError` 回给模型；不校验 `inputSchema`，由 server 校验（tools DECISIONS 第 11 条）。

## 代价
错误是自然语言，模型和 UI 都要靠文本理解；结构化信息只能放 `data`（模型看不到）。

## 同一工具连续失败（2026-11-12 拍板：不设上限）
同一个工具连续失败 N 次后要不要结束 turn（`core.md:200`）：不限，由模型自己决定放弃，见 core/DECISIONS 第 8 条。兜底只有整个 turn 的步数上限（`runTurn` 的 `maxSteps`，默认 50，`core/src/loop.ts:66`）和可选的 `stopWhen`（`core/src/stop.ts`）；没有按工具计数的失败上限。

## 如何验证（eval / 测试）
- core 的 loop 测试覆盖 `invalid_tool_input`。
- 没有用真实模型观察过它会不会陷入重试循环。
