# @hue/gateway

把一个 agent 放到 HTTP 后面:别的程序发任务、订阅事件流、插话、打断、批准工具调用;外加一个带签名的 webhook 渠道,用来接 IM。只依赖 `@hue/core` 和 Node 内置的 `node:http` / `node:crypto`,没有第三方库。

```ts
import { createGateway, webhookChannel } from '@hue/gateway'

const gateway = createGateway({
  store, tokens: [process.env.HUE_GATEWAY_TOKEN!],            // 至少 16 个字符
  agent: input => createAgent({ model, store, tools, policy, input }),   // input = gateway 的 InputPort:人的批准从 HTTP 回来
  channels: [webhookChannel({ name: 'hook', secret, send: (conversation, text) => postToChatPlatform(conversation, text) })],
})
await gateway.listen(8787)            // 默认 127.0.0.1;或者 http.createServer(gateway.handler) 挂到自己的服务上
```

| 接口 | 作用 |
|---|---|
| `POST /v1/sessions/:id/messages` `{text}` | 会话空闲就开始一个 turn(`started`),在跑就当插话(`steered`) |
| `GET /v1/sessions/:id/events` | SSE 事件流:先回放 store 里的历史,再接实时;`Last-Event-ID` / `?after=` 续传 |
| `POST /v1/sessions/:id/interrupt` | 打断在跑的 turn |
| `POST /v1/sessions/:id/inputs/:requestId` | 回答 agent 的批准请求 |
| `GET /v1/sessions/:id` | 状态:是否在跑、最后的 seq、待回答的请求 |
| `POST /channels/:name` | IM 渠道入口,用签名而不是 token 鉴权 |
| `GET /healthz` | 探活 |

安全默认值:必须配 token(或显式 `insecureNoAuth`,且只能绑回环);不认识的 `Host` 和 `Origin` 一律拒绝(防 DNS rebinding);请求体、并发会话数、事件流数、每分钟请求数都有上限。

**完整的接口、事件格式、curl / JS / 签名示例、部署清单和写新渠道的方法见 [INTEGRATION.md](INTEGRATION.md)。** 取舍见 [DECISIONS.md](DECISIONS.md)。

## 依赖
`@hue/core`(类型)。agent 用结构类型 `AgentLike` 接入,不 import `@hue/runtime`——runtime 的 `Agent` 恰好满足它。

## 测试

```bash
cd hue
npx tsc -p packages/gateway
node --import tsx --test packages/gateway/test/*.test.ts     # 46 个,npm test 也会跑
node --import tsx --test examples/gateway.test.ts            # 真 runtime + policy + sqlite 的端到端
```

包内的测试用一个假 agent(像 runtime 一样先落盘再 yield)和真的 `http` 服务,覆盖:鉴权、Host / Origin、限流、请求校验、事件流的回放与实时衔接(不重复不丢)、插话与打断、批准、出错、关闭、IM 渠道的验签。`examples/gateway.test.ts` 用真实的 runtime、policy、sqlite 再跑一遍批准、拒绝、打断和关闭。

## 没验证的

- **没有用真实模型、真实浏览器或真实 IM 平台试过**;`examples/gateway.ts` 只通过了类型检查,没有真正启动过(冒烟被拦了)。
- **没有 WebSocket**:用 SSE + POST 覆盖了同样的需求(见 DECISIONS 第 1 条)。
- **没有为具体 IM 平台(Slack、飞书、Telegram…)写适配**,只有通用的签名 webhook 渠道和写新渠道的接口;各平台的签名算法与事件格式我没核实过。
- **慢客户端没有背压处理**:事件流里写不出去的数据会堆在内存里(见 DECISIONS 第 9 条)。
- **没有 TLS、没有按会话的权限**:所有 token 能访问所有会话,TLS 靠前面的反向代理。
- 没有压力测试;限流是进程内的,多实例各算各的。
