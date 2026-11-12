# @hue/tools（内置工具）决定记录

## 1. edit 用什么格式？

| | 精确字符串替换（选了） | 行号 patch | unified diff |
|---|---|---|---|
| 模型要写什么 | 原文片段 + 新片段 | 起止行号 + 新内容 | 带上下文的 `@@` hunk |
| 最容易错在哪 | 缩进/空白不一致 | **行号**：模型数不准，且前一次编辑后行号全变 | hunk 头里的行数计数，上下文行抄错 |
| 失败时 | 明确："找到 0 处 / N 处" | 悄悄改错位置 | 整个 patch 被拒，错误难读 |
| 并发/重放 | 重放时找不到原文 → 安全失败 | 重放会改错位置 | 重放通常失败，但不总是 |

- **选了**：精确字符串替换（`old_string` / `new_string` / `replace_all`）。
- **为什么**：失败是响应式的、可读的，且不会改坏文件；这也是它能标 `idempotent` 的依据（有测试：同一调用执行第二次会失败但文件不变）。
- **细节**：0 处匹配时，如果去掉首尾空白后能找到，提示检查缩进；CRLF 文件用 LF 的 `old_string` 也能匹配，写回时还原 CRLF；用 `split/join` 而不是 `String.replace`，避免 `new_string` 里的 `$&` 被当成替换模式；非 UTF-8 文件拒绝编辑（否则解码成 `�` 再写回会悄悄破坏文件）；BOM 保留。
- **代价**：改动大段代码时模型要把整段原文再抄一遍，费 token；没有"一次改多处不同位置"（模型要调用多次）。
- **何时要改**：eval 里发现"找不到原文"占失败的大头时，考虑加模糊匹配（容忍空白差异）。

## 2. 路径：是否强制相对 workdir，怎么处理 `..`

- **选了**：文件类工具（read/list/write/edit）只做 `posix.normalize`，相对路径接到 `cwd` 选项下；绝对路径不动。**不拦截越界**，越界交给 sandbox。
- **为什么**：工具不是安全边界。在工具里写一套"是否越界"的检查，会和 sandbox 的检查重复，而且两处规则会漂移。
- **例外**：`glob` / `grep` 不把相对路径接到 `cwd` 上，因为 `exec` 本来就在 `cwd` 里跑；保持相对路径，结果里的路径才短、模型才好读。
- **代价**：用没有越界检查的 sandbox（如测试里的 fake）时，`../../etc/passwd` 能读到。
- **更新**：`@hue/sandbox` 已实现，`local` 和 `docker` 的文件接口都会拦住越界和符号链接逃逸。`bash` 的命令本身在 `local` 里仍不受路径限制，只有 `docker` 把它关在容器里。
- **何时要改**：补一个"工具 + 真 sandbox"的越界测试（`examples/agent.test.ts` 里已有一个 read 的）。

## 3. 截断策略

- **选了**：默认 30 KB（`maxOutputBytes` 可调）。超长时保留头尾、中间写明省略了多少字节和怎么看完整内容；结果（含提示）**严格不超过**上限，按字节算，不会切坏多字节字符。
- **head/tail 比例**：默认 6/4；`bash` 用 4/6，因为命令输出的错误和总结在结尾。
- **read 不用这套**：它按行分页（默认 2000 行、单行 2000 字符），被截断时说"用 offset=N 继续"，至少返回一行。
- **代价**：30 KB 约 8k token，一次 grep/bash 就占一大块上下文。数值是经验值，没有用真实任务调过。
- **何时要改**：有真实任务数据后；或 `@hue/context` 开始折叠旧工具结果时重新评估。

## 4. 实现时做的其他决定

| 决定 | 原因 |
|---|---|
| 同一份字段表生成 `inputSchema` 和 `parse` | 手写校验，不引入 zod；两边不会漂移。未知参数也拒绝（模型常把 `path` 写成 `file_path`），错误信息写明期望的参数名。 |
| glob/grep 在 shell 里判断 `command -v rg`，没有就退回 `find` / `grep -E` | 最小镜像里不一定有 ripgrep；只多一次 exec，且判断和执行在同一环境。两个分支都用真 shell 测过。 |
| 所有拼进 shell 的值都用单引号转义 | 模型给的 pattern 绝不能被 shell 解释。有测试用 `'; touch …` 和 `$(touch …)` 验证没有被执行。 |
| `bash` 的 `timeoutMs` 比 sandbox 超时多 10 秒 | 让 sandbox 先杀进程并返回结构化结果；loop 的兜底超时只在 sandbox 失灵时触发。 |
| 搜索"没有匹配"是正常结果，正则写错才是错误 | `rg`/`grep` 退出码 1 就是没匹配；有 stderr 才是真错误。 |
| 已取消的调用在任何 I/O 之前就抛 `AbortError` | `toolContract` 要求，也避免取消后还写文件。 |
| 没有 sandbox → 返回明确的错误结果而不是崩溃 | 任务书要求。 |

# MCP client

## 5. 怎么判断对面是老 server？

- **问题**：新规范要求 server 实现 `server/discover`，但现存的大多是 2025-11-25。stdio 没有状态码，老 server 对未知方法的反应各不相同（`-32601`、`-32602`、一个别的错误，甚至不作声）。
- **选了**：按规范——先 `server/discover`；返回结果就是新协议；返回 `-32020/-32021/-32022`（只有新协议才会有的错误码）就是新协议（-32022 则换版本重试）；**其它任何错误、stdio 上超时不作声、HTTP 上 400/404/405 且响应体不是新协议的错误**都当老 server，回退到 `initialize`。HTTP 上 401、5xx、连不上不是"老 server"，是真错误，直接抛。
- **为什么不只认 -32601**：规范明确说不能绑定某一个错误码；有测试（HTTP 的老 server 回一个纯文本 400）。
- **代价**：stdio 上探测超时默认 10 秒，对一个启动很慢的新协议 server 会被误判成老 server（回退后发的 initialize 会失败，报错信息里能看出来）。探测结果只在进程生命周期内缓存；进程重启后重新探测。
- **何时要改**：真实 server 里出现误判时。

## 6. clientCapabilities 声明什么？

- **选了**：只声明 `elicitation: { form: {} }`（表单类 elicitation）。不声明 sampling / roots（规范已弃用）、不声明 URL 模式。老协议握手里声明空对象。
- **为什么**：MRTR 里 server 不能向没声明能力的 client 要它做不到的事，所以声明得少，server 就少给我们出难题。表单类可以直接映射到 core 的 `InputPort`（`kind: 'form'`），不用造新机制。
- **代价**：需要 URL 模式（OAuth 授权、输入密钥）的 server 用不了。收到不支持的 input 请求仍然返回明确的错误，而不是崩溃。
- **规范说表单不能用来收密码 / 密钥**：表单走的是 `ctx.requestInput`，由调用方的 UI 呈现。这里不做校验——**谁在问**（哪个 MCP server）要不要显示给用户，是 UI 的事；core 的 `InputRequest` 目前没有"来源"字段，UI 只能从工具名（`<server>__<tool>`）推断。

## 7. 回退默认开吗？一个 stdio 进程多会话共享吗？

- **回退**：默认开（现实里大多数 server 还没升级）；`fallback: false` 关。
- **共享**：一个 `mcp.stdio(...)` 返回的 Capability 对应一个进程，凡是用到它的会话 / 子 agent 都共享（协议已无状态，列表缓存也能共享）。想隔离就各建一个。
- **代价**：共享意味着一个会话把 server 搞崩，其他会话的在途请求也丢（由断流重发规则处理）。

## 8. 断流重发和副作用

- **选了**：连接层面的失败（进程退出、HTTP 流断、连接被重置）时，工具 `effects` 为 none / idempotent 就用**新请求 ID** 重发一次（规范要求：流断了请求就丢了，必须是新请求）；unsafe 的不重发，返回错误结果："不确定是否已生效，先查当前状态"。
- **为什么**：这个"结果未知"是真实的——请求可能已经被执行了。把决定交给模型比替它赌好。
- **局限**：`effects` 取自 server 的 annotations（见第 9 条），server 说谎就会重发一个其实不幂等的调用。重发是整个调用从头来（包括 MRTR 的表单）：断在第三轮时用户要再答一遍。
- **其他 JSON-RPC 错误不重发**：那是 server 明确的拒绝。

## 9. 相信 server 的 annotations 吗？

- **选了**：默认相信（任务书要求），映射为 `readOnlyHint → none`、`idempotentHint → idempotent`、其余 unsafe；`effects: { 工具名: … }` 覆盖，`trustAnnotations: false` 一律 unsafe。
- **风险**：规范说"除非来自可信 server，否则 annotations 不可信"。`none` 意味着可并发、可自动重发、policy 预设（`readOnly`、`coding`）可能直接放行——一个恶意 server 把有副作用的工具标成只读就能绕过确认。
- **建议**：只对自己信任的 server 保持默认；第三方 server 用 `trustAnnotations: false`。默认值选了任务书要的（默认信），没有选更安全的那个；2026-11-12 你确认保持默认信，见 [ADR-010](../../../docs/decisions/ADR-010-mcp-trust-annotations.md)。

## 10. MRTR 的边界

- 最多重试 5 轮（`maxInputRounds`），超过返回错误结果，不抛——模型可以决定放弃。重发的是**原请求加这一轮的答案**，不累积上一轮的 `inputResponses`（有测试）；server 没给 `requestState` 就不带；只有 `requestState` 没有 `inputRequests` 时直接重发。
- 用户在表单上点拒绝 / 取消，原样转给 server（`decline` / `cancel`），由 server 决定怎么办。
- **等用户输入期间这个 tool.call 算什么**（设计页的 `TODO(deep)`）：算还在执行，整个过程是工具执行里的一次 `ctx.requestInput`，loop 会发 `input.requested / input.resolved` 事件。打断时 `ctx.signal` 触发，在途的请求被取消。工具超时（默认 120 秒）把等待用户的时间也算进去，MCP 工具若常需要人填表，调用方要调大 `timeoutMs`——**这一点现在没有处理**。

## 11. 其他

| 决定 | 原因 |
|---|---|
| server 主动发来的请求（老协议的 `roots/list`、`sampling/createMessage`、`elicitation/create`）一律回 -32601 | 我们没声明这些能力；回一个错误让它别等。不做老协议的 elicitation 适配（求职版不做）。 |
| `tools()` / `instructions()` 连不上就抛，让这个 turn 以错误结束 | 悄悄少几个工具，模型会以为那些工具不存在。代价：一个挂掉的 MCP server 能让整个 agent 起不来。以后可能改成"返回上次缓存的列表并告警"。 |
| 工具名里的非法字符换成 `_`，总长 ≤ 64 | Anthropic 只收 `[a-zA-Z0-9_-]{1,64}`，MCP 工具名允许 `.`。换名后碰撞（`a.b` 和 `a_b`）没有处理。 |
| image → `FilePart`（data URL）；audio、资源链接、嵌入资源 → 文本说明 | core 的内容类型里没有 audio / 资源；二进制资源不进上下文。 |
| `structuredContent` 进 `ToolOutput.data`，没有文本时补一份 JSON 文本 | `data` 不发给模型，有的 server 只给结构化结果。 |
| 结果大小：MCP 工具的结果也被 `@hue/runtime` 的 `maxToolOutputBytes`（默认 100 KB）兜底 | 见 core/DECISIONS 第 7 条；以前这里没有统一上限。 |
| 不校验 `inputSchema` / `outputSchema` | core 不带校验器；server 自己校验，错误作为 `isError` 回给模型。 |
| 请求里的 `progressToken` 就是请求 ID | 通知靠它对回请求；进度只转给 `ctx.progress`，不重置超时。 |
| HTTP 不支持 `subscriptions/listen`、认证只有固定头 | 求职版不做；OAuth 是 `LATER`。 |
| `mcp.stdio` 的 `env` 是在继承宿主环境变量的基础上追加 | **会把宿主的全部环境变量（含密钥）给 MCP server**。我印象里官方 SDK 默认只传一个白名单，没核实过 `TODO(verify)`。`@hue/sandbox` 的 local 模式是白名单，这里没跟。需要时由调用方控制。 |
