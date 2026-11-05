# @hue/tools

## 职责
内置工具（read/edit/bash/glob/grep）与 MCP client；定义工具接入规范。

## 不做
不做审批（policy）、不做隔离（sandbox），但留钩子。

## 接口草图（非最终）
```ts
export const readFile: () => Tool
export const editFile: () => Tool   // DECIDE: 搜索替换 vs 行号 patch vs unified diff
export const bash: (opts?: { cwd?: string; timeoutMs?: number }) => Tool
export const mcp: {
  // 无状态：connect 不做握手，只建传输；可选先调 server/discover 选版本
  connect(transport: 'stdio' | 'http', target: string, opts?: McpOptions): Promise<McpClient>
}
interface McpClient { tools(): Promise<Tool[]>; discover(): Promise<DiscoverResult>; close(): Promise<void> }
interface McpOptions {
  protocolVersion?: '2026-07-28'          // 默认最新
  fallback?: '2025-11-25' | false         // 老 server 回退，见下文兼容小节
  onInputRequired?: InputHandler          // MRTR：server 要更多输入时谁来回答
}
```

## 关键问题
- TODO(deep): 手写 MCP client，按 2026-07-28 规范（无状态），细节见下方「MCP client 设计」。先 stdio，再 Streamable HTTP
- TODO(deep): 工具结果太大怎么办——截断、落盘给路径、由 context 折叠？和 context 包的边界
- DECIDE: edit 工具格式（各家对比是很好的拆解素材）
- DECIDE: 工具错误回传给模型的格式（isError + 文本？结构化？）
- TODO(deep): 工具接入规范文档——命名、schema 约定、幂等/副作用标注（给 policy 和回放用）
- LATER: MCP resources / prompts、subscriptions/listen、tasks extension、OAuth（Roots、Sampling、Logging 已被规范弃用，不做）

## MCP client 设计（规范 2026-07-28）

> 依据：https://modelcontextprotocol.io/specification/2026-07-28/changelog （2026-10-30 核对）。
> 相对 2025-11-25 的核心变化：**MCP 变成无状态**。这让手写 client 简单不少，也是很好的拆解素材。

### 1. 没有握手，每个请求自带上下文
- 不再有 `initialize` / `notifications/initialized`。
- 每个请求的 `_meta` 都带：
  - `io.modelcontextprotocol/protocolVersion`（必带）
  - `io.modelcontextprotocol/clientCapabilities`（必带）
  - `io.modelcontextprotocol/clientInfo`（SHOULD，Hue 总是带）
  - `io.modelcontextprotocol/logLevel`（可选；不带则 server 不得发 `notifications/message`）
  - 可选 OTel 追踪：`traceparent` / `tracestate` / `baggage`（给 @hue/telemetry 用）
- server 在每个 result 的 `_meta` 里带 `io.modelcontextprotocol/serverInfo`。
- 实现：一个 `withMeta(req)` 包装，所有请求都过它；client 端不持有任何协议会话状态。
- DECIDE: clientCapabilities 求职版声明什么（候选：只声明 MRTR 能处理的 input 类型 + 空 extensions）

### 2. server/discover：版本选择与探测
- server **必须**实现 `server/discover`，返回支持的协议版本、capabilities、身份。
- Hue 策略：连接后先调一次 discover，选出双方都支持的最高版本，并缓存 server 能力（只是缓存，不是会话）。
- 版本不匹配时 server 返回 `UnsupportedProtocolVersionError`（-32022）→ 用 discover 结果换版本重发一次，仍失败就报错。
- 其他新错误码：`HeaderMismatchError`（-32020）、`MissingRequiredClientCapability`（-32021）；resource not found 改为 -32602。

### 3. 每个 result 都有 resultType
- `"complete"`：普通结果。
- `"input_required"`：MRTR 中间结果（见第 4 点）。
- 老版 server 不带这个字段时，**必须**按 `"complete"` 处理。

### 4. 多轮请求 MRTR（取代 server 主动发请求）
- server 需要更多输入时返回 `resultType: "input_required"` + `inputRequests`。
- client 收集答案后，把 `inputResponses` 放进**原请求**重发（新 request ID）；server 需要跨轮关联时自己放 `requestState`，client 原样带回。
- 取代了 server 主动发起的 `roots/list`、`sampling/createMessage`、`elicitation/create`。
- Hue 映射：`input_required` → 发 HueEvent（如 `tool.input_required`）→ 由 `onInputRequired` 处理（交给 policy / 用户 / 自动回答）→ 重发。
- TODO(deep): MRTR 和 loop 的关系——等待用户输入期间这轮 tool.call 算挂起还是结束？打断时怎么收尾？最多重试几轮防死循环？
- DECIDE: 求职版支持哪些 input 类型（候选：只做 elicitation 表单类，sampling 直接拒绝）

### 5. 列表结果可缓存
- `tools/list`、`prompts/list`、`resources/list`、`resources/read`、`resources/templates/list` 必带 `ttlMs` 和 `cacheScope`（`public` / `private`）。
- server SHOULD 保持 `tools/list` 顺序确定。
- Hue 做法：按 `ttlMs` 缓存工具列表；**保持 server 给的顺序**拼进 system prompt，不要自己排序打乱 —— 直接关系到 prompt cache 命中（和 @hue/context 的缓存友好目标一致）。
- 列表不再因连接而不同，所以多个 agent / 子 agent 可以共享同一份缓存。

### 6. 传输
**stdio（先做）**
- 子进程 + 换行分隔 JSON-RPC；stderr 当日志（规范建议 Logging 改走 stderr）。
- 取消：`notifications/cancelled` + AbortSignal 贯穿。超时由 client 自己计。
- 进度：`notifications/progress` 只出现在对应请求的响应流里。

**Streamable HTTP（第二步）**
- 没有 `Mcp-Session-Id`，没有协议级会话。
- 每个 POST 必须带 `Mcp-Method` 和 `Mcp-Name` 头（name 对应工具名等）；工具参数可通过 `x-mcp-header` 映射成自定义头。
- 没有 SSE 续传（`Last-Event-ID` 已删）：流断了 = 这次请求丢了 → 用**新 request ID** 重发。
  - TODO(deep): 重发和副作用——unsafe 工具断流后能不能自动重发？和 tools 接入规范里的 `sideEffect` 标注联动（默认：none/idempotent 自动重发，unsafe 交给模型判断）
- 需要跨调用状态的 server 会发一个句柄，作为普通工具参数来回传；client 不需要任何特殊处理，模型照常传参即可。
- 已删除：GET 端点、`ping`、`logging/setLevel`。变更通知改用 `subscriptions/listen`（一个长 POST 响应流，按类型订阅）→ LATER。

### 7. 兼容 2025-11-25 版 server
新规范要求 server 实现 discover，但现存大量 server 还是 2025-11-25 版。Hue 的回退顺序：
1. 先调 `server/discover`。
2. 如果返回 Method not found（-32601）或类似失败 → 判定为老 server，回退到 2025-11-25 流程：
   - 发 `initialize`（protocolVersion `2025-11-25`）→ 收到结果后发 `notifications/initialized`
   - HTTP 上保存并回传 `Mcp-Session-Id`；支持 GET 端点（或不用）
   - result 缺 `resultType` 一律按 `complete`
   - server 主动发来的 `roots/list` / `sampling/createMessage` / `elicitation/create`：求职版一律回错误，或只对 elicitation 做简单适配
3. 两种模式对上层暴露同一个 `McpClient` 接口，差异全部关在一个 `legacy.ts` 里。
- DECIDE: 回退是否默认开启（候选：默认开，因为现实中的 server 大多还没升级）
- TODO(verify): 选 2 个真实 server，确认各自实现的是哪个版本；官方 SDK 当前版本是否已支持 2026-07-28

### 8. 测试计划
- 协议级单测：`_meta` 每个请求都带齐；-32022 换版本重发；缺 `resultType` 按 complete；MRTR 一轮和两轮；断流重发用新 ID。
- 对照：同一个 server，Hue 和官方 SDK 各录一份 JSON-RPC 报文逐条对比。
- 一个故意出错的 mock server（错版本、错头、断流、无限 input_required）。

## 各家怎么做（对照答案）
- Pi：MCP 是零依赖独立包 TODO(verify)
- Claude Code：工具集与 edit 格式 TODO(verify)
- Mastra：MCPClient TODO(verify)
- 官方 @modelcontextprotocol/sdk 作为对照答案

## 结论
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
能连上 2 个真实 MCP server（如 filesystem、github），至少覆盖一个 2026-07-28 版和一个 2025-11-25 版（走回退）；MCP client 不依赖官方 SDK；有协议级测试

## 对应 JD
MCP 工具体系、调用链路底层、接入规范

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
- 《MCP 变成无状态之后，client 少写了什么、多写了什么》：握手消失、discover、MRTR、断流重发 —— 适合作为构建日志 #2
