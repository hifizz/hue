# DECISIONS

## Q1: 封装官方 SDK 还是手写 HTTP+SSE？
- 选项 A：`@anthropic-ai/sdk`
- 选项 B：手写 fetch + SSE 解析 + 事件折叠
- **选了 B。**
- 为什么：a) Hue 的定位是「拆开给你看的 harness」，一层薄 SDK 适配器看不出任何东西，手写三层（HTTP/SSE/事件折叠）每层 100 行左右，正好是 learn/02-streaming 的产品化；b) Node ≥ 20.3 内置 fetch + TextDecoder，协议层没有 SDK 能替掉的部分；c) 零第三方运行时依赖，供应链面最小。
- 代价：要自己跟 Anthropic 的事件协议演进（新事件类型靠 `default: 忽略` 兜底）；重试、连接池这些 SDK 送的东西都没有（本来也不该在这层做）。
- 何时改：当第二家 provider 出现、公共层需要抽取时，重新评估是否借用各官方 SDK。

## Q2: tool-call 的 tool-input-delta 要不要发？
- 发。core 的 ModelChunk 里有这个类型（注释：只给 UI 用），合同不管它。实现上随 `input_json_delta` 透传，UI 能实时渲染参数。

## Q3: 无签名 thinking 块丢弃还是报错？
- 丢弃。与 Anthropic 的行为对齐：签名缺失的推理块发回去会被拒绝；loop 层本就不该把不完整推理放进历史。在 convert.ts 注释里写明。

## Q4: 模型清单（contextWindow / maxOutputTokens）放哪？
- 本包内置一个小表（opus/sonnet/haiku 三个前缀），未命中走保守 fallback。不做成配置文件——维护成本高于收益，且 core 的 ModelInfo 允许各装配点覆盖。

## Q5: `ai()` 对不认识的 provider 返回 undefined 还是抛错？
- 返回 undefined。与合同测试 `make(): ModelPort | undefined` 的约定一致：调用方拿到 undefined 时知道「这个包不提供该 provider」，比抛错更容易组合。

## 已知限制（诚实清单）
- 不处理 `pause_turn` stop reason（映射为 `other`）。
- 不做请求级重试。
- `web_search` 等 server tools 的块类型走 `ignored`，不产出 chunk。
