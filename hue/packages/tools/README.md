# @hue/tools

编码 agent 用的内置工具：`read` `list` `glob` `grep` `edit` `write` `bash`。所有 I/O 都走 `ctx.sandbox`，换执行环境不用改工具。零运行时依赖。

另有一个手写的 MCP client（`mcp.stdio` / `mcp.http`，不依赖官方 SDK），把任意 MCP server 的工具变成 core 的 `Capability`，见下面「MCP」。

```ts
import { codingTools } from '@hue/tools'
import { runTurn } from '@hue/core'

// codingTools 顺序固定（工具列表是 prompt cache 前缀的一部分）
runTurn({ /* … */ tools: codingTools({ cwd: '/path/to/repo' }) })
```

也可以单个用：`read({ cwd })`、`bash({ timeoutMs: 60_000, maxOutputBytes: 10_000 })`。

| 工具 | effects | 说明 |
|---|---|---|
| `read` | none | 带行号；`offset`/`limit` 分页；二进制不给内容 |
| `list` | none | 列一个目录，目录在前 |
| `glob` | none | 按名字模式找文件（rg，退回 find） |
| `grep` | none | 正则搜内容（rg，退回 grep -E） |
| `edit` | idempotent | 精确字符串替换，要求匹配唯一或 `replace_all` |
| `write` | idempotent | 整文件写入，自动建父目录 |
| `bash` | unsafe | 经 sandbox.exec；超时、非零退出码当错误、输出头尾截断 |

返回给模型的文本不超过 `maxOutputBytes`（默认 30 KB）。没有 `ctx.sandbox` 时返回明确的错误结果。

## MCP

```ts
import { mcp } from '@hue/tools'

const fs = mcp.stdio('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], { name: 'fs' })
const gh = mcp.http('https://example.com/mcp', { name: 'gh', headers: { Authorization: 'Bearer …' } })
createAgent({ model, store, capabilities: [fs, gh] })   // 用完 await fs.close()
```

- 按 **2026-07-28 规范**（无状态：没有握手，每个请求的 `_meta` 自带版本、能力、身份）。先调 `server/discover`；对面是老 server（discover 报任何非新协议的错误，或 stdio 上不作声，或 HTTP 上 400/404/405 且不是新协议的错误体）就回退到 2025-11-25 的 `initialize` 握手，差异都关在 `mcp/legacy.ts`。`fallback: false` 可关。
- 工具名 `<name>__<工具名>`（服务商只接受 `[a-zA-Z0-9_-]`，别的字符换成 `_`），顺序是 server 给的，按 `ttlMs` 缓存。
- **effects** 来自 annotations：`readOnlyHint` → none，`idempotentHint` → idempotent，其余 unsafe；`effects: { 工具名: … }` 可覆盖，`trustAnnotations: false` 则全部 unsafe。
- **server 要更多输入（MRTR）**：表单类 elicitation 交给 `ctx.requestInput`（就是 core 的 InputPort 通道），答案连同 `requestState` 放回原请求、用新 ID 重发，最多 5 轮。sampling / roots / URL 模式不支持，返回明确的错误。
- **取消**：stdio 发 `notifications/cancelled`；HTTP 关掉响应流（老协议的 HTTP 要发通知）。
- **连接断了**：只读 / 幂等的工具用新 ID 重发一次；不可重复的不重发，告诉模型"结果未知"。stdio server 意外退出后下次请求重新拉起并重新探测。
- 子进程在 `close()`（关 stdin → SIGTERM → SIGKILL）和宿主进程退出时被清理。
- HTTP：`Mcp-Method` / `Mcp-Name` 头、`x-mcp-header` 参数头（不合法的工具被丢掉并通过 `onWarning` 提示）、SSE 和 JSON 两种响应。
- 不做：resources / prompts、`subscriptions/listen`、tasks 扩展、OAuth。

排查真实 server：`npx tsx examples/mcp-smoke.ts stdio <命令> …`（见该文件开头），会打印对面说哪一代协议、有哪些工具。

## 测试


```bash
cd hue
npx tsc -p packages/tools
node --import tsx --test packages/tools/test/*.test.ts   # 内置工具 62 个 + MCP 58 个，npm test 也会跑
```

每个工具都过 core 的 `toolContract`。edit/read/bash 等用内存版 fake sandbox；glob/grep 另外用**真 shell** 跑（含没有 rg 的回退分支）。

MCP 部分用测试里自带的 mock server：stdio 的是真子进程，HTTP 的是真 `http` server（JSON 和 SSE 两种响应）。覆盖：每个请求的 `_meta` 和头、版本协商与 -32022 换版本重发、缺 `resultType`、MRTR（一轮、两轮、无限、不支持的类型、用户拒绝）、老 server 回退（stdio 报错 / 不作声、HTTP 400 / 会话过期 404）、取消、断流重发、列表缓存与分页、进程清理（含不听话的 server 和宿主直接退出）、x-mcp-header。适配出的工具过 `toolContract`。

## 没验证的

- 工具的 description 是否能让模型用对，只在一个 5 行的演示仓库上用真实模型试过两次（见 `examples/README.md`）。
- 工具本身不拦路径越界，交给 sandbox（见 [DECISIONS.md](DECISIONS.md) 第 2 条）。`@hue/sandbox` 已实现，但 `local` 里的 `bash` 仍能 `cd` 出去，要隔离请用 `docker`。
- **bash 没有权限控制**（policy 未实现），根目录 README 的里程碑文档要写明这点。
- 30 KB 截断上限是经验值，没用真实任务调过。
- **MCP 只对着自己写的 mock server 测过**，没有连过真实的 MCP server，也没有和官方 SDK 对照报文——任务书要求的"连上 2 个真实 server、一个走新协议一个走回退"和"报文对照"都还没做。mock 是按我读到的规范写的，我和 mock 对规范的误读会互相掩盖。
- 2026-07-28 规范我是在 2026-11-10 从 modelcontextprotocol.io 读的（发现、MRTR、HTTP 头、取消、elicitation 几页），请求 / 响应字段名以那几页为准；`clientCapabilities` 里 `elicitation: { form: {} }` 的写法来自 elicitation 页。
- 工具结果太大怎么办（设计页的 `TODO(deep)`）没处理：MCP 工具的输出原样进上下文，只有 `@hue/context` 的折叠能事后收拾。
