# 任务：@hue/tools（MCP client 部分）

**预算** 约 900 行（与内置部分共享 1600）· **依赖** core（**不得**依赖官方 `@modelcontextprotocol/sdk`，测试里可用它做对照）· **目录** 只改 `packages/tools/src/mcp/` 和对应测试

## 必读
`docs/packages/tools.md` 的「MCP client 设计（规范 2026-07-28）」整节，这是本任务的规格。目标版本 2026-07-28，回退 2025-11-25。

## 对外 API
```ts
import { mcp } from '@hue/tools'
const fs = mcp.stdio('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], { name: 'fs' })
const gh = mcp.http('https://example.com/mcp', { name: 'gh', headers })
// 两者都返回 core 的 Capability：instructions 为空（或 server 的 instructions），tools() 返回适配好的 Tool[]
```

## 必须做到
1. **作为 Capability 暴露**：`tools(ctx)` 返回的 Tool 名为 `<name>__<toolName>`（避免撞名），保持 server 给的顺序；按 `ttlMs` 缓存列表。
2. **effects 映射**：从 MCP tool annotations 推出：`readOnlyHint` → none，`idempotentHint` → idempotent，其他 → unsafe。没有 annotation 时默认 unsafe。允许配置覆盖。
3. **无状态请求**：所有请求经过一个 `withMeta()`，`_meta` 带齐 protocolVersion、clientCapabilities、clientInfo。
4. **discover 与回退**：先 `server/discover`；-32601 等失败 → 进入 legacy（`initialize` → `notifications/initialized`，HTTP 带 `Mcp-Session-Id`）。legacy 差异全部关在 `legacy.ts`。
5. **MRTR**：`resultType: "input_required"` → 对每个 inputRequest 调 `ctx.requestInput()`（这就是 core 的 InputPort 通道）→ 把 `inputResponses` 和 `requestState` 放回原请求、用新 request ID 重发。最多 5 轮，超过返回错误结果。
6. **结果转换**：MCP content → core `ToolContent`；`structuredContent` → `ToolOutput.data`；`isError` 透传。
7. **取消**：`ctx.signal` → `notifications/cancelled`；超时同理。
8. **HTTP 断流重发**：仅当工具 effects 为 none / idempotent 时自动用新 ID 重发一次；unsafe 返回错误结果说明"结果未知"。
9. 子进程在 `close()` 和进程退出时被清理。

## 你来决定
- clientCapabilities 声明哪些 input 类型（建议：只声明 elicitation 表单类；sampling 拒绝）。
- 回退是否默认开启（建议开）。
- 一个 stdio server 进程是否被多个会话共享（建议共享：协议已无状态）。

## 额外测试
- 写一个 mock server（stdio，测试内）：正常、错版本 -32022、缺 resultType、两轮 MRTR、无限 input_required、legacy-only server、中途退出。
- 报文对照：同一个真实 server（filesystem），Hue 与官方 SDK 各录一份 JSON-RPC 报文，测试里比对关键字段。
- 适配出的每个 Tool 过 `toolContract`。
- 验收：连上 2 个真实 server，至少一个走 2026-07-28、一个走回退。

## 不做
resources / prompts、`subscriptions/listen`、tasks extension、OAuth（LATER）；Roots / Sampling / Logging（规范已弃用）。
