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
- HTTP / WebSocket / IM 接入，把 Agent 事件流推给客户端
- LATER

## @hue/telemetry
- 订阅事件 → OpenTelemetry span（gen_ai 语义约定 TODO(verify)）
- Pi 做法：零依赖独立包 TODO(verify)
- LATER
