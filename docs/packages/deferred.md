# 后置的包（求职版只写接口与设计）

## @hue/policy
- 接口：`decide(call: ToolCall, ctx): 'allow' | 'deny' | 'ask'`，在 core 里定义
- DECIDE: 规则格式（allowlist / glob / 函数）
- LATER: 审批 UI 事件、记住决定

## @hue/sandbox
- 接口：`exec(cmd, opts): Promise<ExecResult>`；bash 工具通过它执行
- 候选实现：本地子进程（默认）/ Docker / E2B / Fly Sprites（TARS 姊妹仓库经验）
- LATER

## @hue/gateway
- 已实现骨架,设计见 `gateway.md`,代码 `hue/packages/gateway`(HTTP + SSE + 签名 webhook;没做 WebSocket)

## @hue/telemetry
- 已实现,代码 `hue/packages/telemetry`(事件 → OTel GenAI span,OTLP/HTTP JSON;设计与取舍见该包 DECISIONS.md)
