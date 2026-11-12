# ADR-010 MCP 工具的 annotations 默认信
- 状态：已接受（2026-11-12，你选了"默认信"）
- 包：@hue/tools（`src/mcp/`）
- 来源标记：无 `DECIDE:`。出处 tools DECISIONS 第 9 条

## 问题
`effects`（none / idempotent / unsafe）驱动并发调度、断流重发、policy 默认。MCP 工具的 `effects` 来自 server 自己声明的 annotations。规范说"除非来自可信 server，否则 annotations 不可信"。默认值怎么选？

## 候选
1. 默认相信（任务书要求）：`readOnlyHint → none`、`idempotentHint → idempotent`、其余 unsafe。
2. 默认不信：一律 unsafe，用户按工具名用 `effects: { 工具名: … }` 显式放行。

## 各家怎么做（附出处）
没有核实过。

## 决定
**选 1，默认信。** 我曾建议选 2（失败方向更安全），你选了 1。代码不变，已有两个开关：
- `effects: { 工具名: … }` 覆盖单个工具；
- `trustAnnotations: false` 让该 server 的所有工具一律 unsafe。

**使用规则**：只对自己信任的 server 保持默认；第三方或不熟的 server 必须设 `trustAnnotations: false`。这条已写进 `hue/packages/tools/README.md`。

## 代价（已知并接受）
`none` 意味着可并发、可自动重发，且 `presets.readOnly` / `presets.coding` 可能直接放行。一个恶意或写错标注的 server，把有副作用的工具标成只读，就能绕过确认和重发保护；防御完全靠调用方记得设 `trustAnnotations: false`，库本身不会提醒。

## 何时要改
- 开始连接第三方 server（例如 HTTP 的 github）时，回头看这个默认值。
- 或者 `mcp.stdio` / `mcp.http` 能区分"自己启动的本地进程"和"远程地址"时，可以只对远程默认不信。
- 若改成默认不信，要同时改 `mcp-unit.test.ts:41` 的断言（现在默认期望 `none`）。

## 如何验证（eval / 测试）
`tools/test/mcp-unit.test.ts:39` 用不带任何选项的 `effectsOf(x, {})` 断言 `readOnlyHint → none`、`idempotentHint → idempotent`、其余 unsafe，所以默认值被锁住了；同一个测试覆盖两个开关（覆盖表优先、`trustAnnotations: false` 全 unsafe）。
