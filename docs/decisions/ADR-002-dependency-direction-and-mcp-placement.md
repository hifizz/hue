# ADR-002 包只依赖 core；MCP client 留在 @hue/tools，不单独成包
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/tools（以及全部包的依赖方向）
- 来源标记：`DECIDE: tools 的 MCP client 要不要单独成 @hue/mcp`（docs/02-architecture.md:31）

## 问题
1. 13 个包之间怎么依赖？
2. MCP client 是 `@hue/tools` 的一部分，还是单独的 `@hue/mcp`？

## 候选
1. 包之间可以互相 import / 包之间只依赖 core，组合只发生在 runtime 或配方里。
2. MCP 单独成包（设计页写的 Pi 做法：零依赖独立包，`TODO(verify)`） / MCP 留在 tools。

## 各家怎么做（附出处）
Pi 把 MCP 做成零依赖独立包——仅见于 `02-architecture.md` 和 `tools.md`，两处都标了 `TODO(verify)`，没对照过源码。

## 决定
- 依赖方向：只依赖 `@hue/core`，不互相 import；组合只发生在 `@hue/runtime` 或调用方的配方。telemetry / eval 只订阅事件。AGENTS.md 把它列为架构硬规则。
- MCP 留在 `@hue/tools`（`src/mcp/`），对外是 `mcp.stdio` / `mcp.http`，返回 `Capability`。不依赖官方 SDK。

**留在 tools 的理由（你确认）：** MCP 和内置工具同属"工具"——MCP 的产出就是 `Tool` / `Capability`，和内置工具在同一层，共用 `effects` 约定和行数预算，没必要拆成另一个包。
出处：任务书 `docs/tasks/wave-1/03-tools-mcp.md` 把 MCP 定在 `packages/tools/src/mcp`，预算"约 900 行，与内置部分共享 1600"；`notes/hue.md:33` 曾写"借鉴 Pi 的 telemetry / MCP 零依赖独立包"，后来 telemetry 独立成了包、MCP 没有。
**没有记录的：** 是否认真评估过"独立成包"的收益（比如别人只想用 MCP client）。如果将来有人要单独用，见"何时要改"。

## 何时要改
想单独发布或单独使用 MCP client 时（现在整个 tools 包捆在一起），或 tools 的预算被 MCP 挤得放不下内置工具时。

## 代价
tools 的行数预算要容得下 MCP（预算 1600，MCP 实现后用了 957）。想单独使用 MCP client 的人必须带上整个 tools 包。

## 如何验证（eval / 测试）
- `npm run budget` 看 tools 没超预算。
- 包的 `package.json` 依赖：2026-11-12 核对，core 无依赖，其余 12 个库包都只依赖 `@hue/core`；唯一例外是 `@hue/cli`，它依赖另外 11 个包——它是配方，规则允许"组合发生在配方里"。注意 `runtime` 也只依赖 core（组装靠调用方传入）。核对命令：`grep -o '"@hue/[a-z]*"' hue/packages/*/package.json`。
- MCP 有 58 个协议级测试；真实 server 冒烟见 ADR-009。
