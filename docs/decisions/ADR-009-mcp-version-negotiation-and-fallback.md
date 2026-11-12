# ADR-009 MCP：按 2026-07-28 无状态协议实现，先 discover，不认识就回退 2025-11-25
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认；真实 server 冒烟 2026-11-10）
- 包：@hue/tools（`src/mcp/`）
- 来源标记：`TODO(verify): 选 2 个真实 server，确认各自实现的是哪个版本`（docs/packages/tools.md，现已有结论）；见 tools DECISIONS 第 5–8 条

## 问题
新规范（2026-07-28）去掉了握手，要求 server 实现 `server/discover`；现存 server 多数还是 2025-11-25。client 怎么判断对面是哪个版本，不认识时怎么办？

## 候选
1. 只支持新规范。
2. 先 `server/discover`，失败回退旧握手，差异关进一个 `legacy.ts`。
3. 只认 `-32601`（Method not found）当作"老 server"。

## 各家怎么做（附出处）
官方 `@modelcontextprotocol/sdk` 作为对照答案，**没有对过报文**，也没有核实它当前是否支持 2026-07-28。

## 决定
选 2。
- 判断：`server/discover` 有结果 = 新协议；返回 `-32020/-32021/-32022`（只有新协议才有的错误码）= 新协议，`-32022` 换版本重试；**其他任何错误、stdio 上超时不作声、HTTP 上 400/404/405 且响应体不是新协议的错误**都当老 server，回退 `initialize`。HTTP 上 401、5xx、连不上不是"老 server"，直接抛。不只认 `-32601`，因为规范明确说不能绑定某个错误码。
- `clientCapabilities` 只声明 `elicitation: { form: {} }`。不声明 sampling / roots（规范已弃用）、不声明 URL 模式。
- 回退默认开，`fallback: false` 关。一个 `mcp.stdio(...)` 对应一个进程，凡用到它的会话和子 agent 共享。
- 断流：none / idempotent 的工具用**新请求 ID** 重发一次；unsafe 的不重发，返回"不确定是否已生效，先查当前状态"。
- MRTR 最多 5 轮，超过返回错误结果而不是抛。

## 代价
stdio 上探测超时默认 10 秒，对启动很慢的新协议 server 会误判成老 server。需要 URL 模式（OAuth、输入密钥）的 server 用不了。一个会话把共享的 server 搞崩，其他会话的在途请求也丢。重发依赖 server 声明的 annotations（见 ADR-010）。

## 如何验证（eval / 测试）
- 58 个协议级测试，用自带的 mock server（错版本、断流、无限 `input_required`、老 server 回纯文本 400）。
- 真实 server 冒烟（stdio，2026-11-10，用户在终端跑的）：filesystem 2.2.0 走 2026-07-28，列工具和调用成功；filesystem 2025.8.21 走回退，列工具和调用成功。
- **没做**：HTTP 的真实 server、真实的 MRTR / 取消 / 断流、与官方 SDK 的报文对照。
