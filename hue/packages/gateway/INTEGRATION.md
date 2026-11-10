# 接入文档:把 Hue agent 放到 HTTP 后面

面向两类人:**部署者**(把 gateway 跑起来、放到网上)和**客户端开发者**(网页、脚本、IM 机器人要和 agent 说话)。

## 0. 先理解三件事

1. **会话**由你起名(`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`,用 UUID 即可)。第一次对一个新 ID 发消息就创建了它;同一个 ID 再发就是接着聊。
2. **发任务和看结果是分开的**:`POST .../messages` 立刻返回 `202`,agent 在后台跑;结果通过 `GET .../events` 的事件流拿。事件流不会因为一个 turn 结束而关闭,你关掉它。
3. **agent 的权力不会因为走了 HTTP 而变小**。拿到 token 的人能让 agent 做它的工具能做的一切(包括跑命令)。**token 就是 shell**(在沙箱里的 shell)。见第 7 节。

```
 客户端 ──POST messages──▶ ┌─────────┐    run()    ┌───────┐
 客户端 ◀──SSE events───── │ gateway │ ◀────────▶ │ agent │──▶ store(事件日志)
 客户端 ──POST inputs────▶ └─────────┘  InputPort  └───────┘
 IM 平台 ──POST /channels/x──▶ (验签)
```

## 1. 在你的程序里启动

```ts
import { createGateway } from '@hue/gateway'
import { createAgent } from '@hue/runtime'

const gateway = createGateway({
  store,                                   // 必须是 agent 写入的同一个 store(事件流从它回放)
  tokens: [process.env.HUE_GATEWAY_TOKEN!], // 至少 16 个字符:openssl rand -hex 32
  // 工厂:gateway 把自己的 InputPort 交给你。agent 要人批准时,请求经事件流发出,答案从 HTTP 回来
  agent: input => createAgent({ model, store, tools, policy, sandbox, input }),
})
const { url } = await gateway.listen(8787)   // 默认只绑 127.0.0.1
// 优雅退出:await gateway.close()
```

- 想挂到自己的服务器上:`http.createServer(gateway.handler)`,或在框架里把 `(req, res)` 交给 `gateway.handler`(Node 原生的请求/响应对象)。
- 已经有 agent 实例、不需要批准:`agent: myAgent`(直接传对象)。
- 可运行的完整例子:`examples/gateway.ts`(见 `examples/README.md`)。
- 需要批准但 agent 不是这样创建的:`gateway.inputPort` 就是那个 `InputPort`,传给 `createAgent({ input })`。

### 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `tokens` | — | Bearer token 列表,每个 ≥ 16 字符。不给就必须 `insecureNoAuth: true` |
| `insecureNoAuth` | `false` | 关掉鉴权。**只能绑回环地址**,`listen` 否则抛错 |
| `allowedHosts` | `localhost`、`127.0.0.1`、`[::1]` | 允许的 `Host` 主机名(不含端口)。绑非回环地址时必须设 |
| `allowedOrigins` | `[]` | 允许的浏览器 `Origin`。空 = 带 `Origin` 的请求一律 403 |
| `channels` | `[]` | IM 渠道,见第 6 节 |
| `maxBodyBytes` | 1 MiB | 请求体上限 |
| `rateLimitPerMinute` | 120 | 每个 token(或每个渠道)每分钟请求数 |
| `maxRuns` | 8 | 同时在跑的会话数 |
| `maxStreams` | 100 | 同时打开的事件流数 |
| `inputTimeoutMs` | 10 分钟 | 等人批准的最长时间,超时按取消处理 |
| `keepAliveMs` | 15 秒 | SSE 保活间隔 |
| `closeTimeoutMs` | 10 秒 | `close()` 最多等在跑的会话多久 |
| `onError` | — | 意料之外的内部错误(客户端只会看到通用的 500) |

## 2. HTTP 接口

所有 `/v1/*` 请求都要带 `Authorization: Bearer <token>`。带请求体的接口要 `Content-Type: application/json`。

### 错误格式

```json
{ "error": { "code": "rate_limited", "message": "too many requests" } }
```

按 `code` 判断,不要解析 `message`。常见的:

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_json` `invalid_text` `invalid_session_id` `invalid_after` `invalid_response` | 请求不合法 |
| 401 | `unauthorized`(渠道是 `bad_signature`) | token / 签名不对 |
| 403 | `forbidden_host` `forbidden_origin` | `Host` / `Origin` 不在白名单 |
| 404 | `not_found` `no_such_request` | 会话 / 路由 / 待批准请求不存在 |
| 405 | `method_not_allowed` | 方法不对,`Allow` 头里写了该用哪个 |
| 409 | `session_finishing` `not_running` | 见下 |
| 413 / 415 | `body_too_large` `text_too_long` / `unsupported_media_type` | |
| 429 | `rate_limited` `too_many_runs` `too_many_streams` | 带 `Retry-After`(秒) |
| 503 | `shutting_down` | gateway 正在关闭 |

### `POST /v1/sessions/:id/messages`

```bash
curl -X POST "$URL/v1/sessions/$(uuidgen)/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"修好 add 函数里的 bug"}'
# → 202 {"status":"started","sessionId":"…"}
```

- `status: "started"`:会话空闲,已经开始一个 turn。
- `status: "steered"`:会话正在跑,这条消息作为**插话**排队,在 agent 的下一个安全点(本步的工具结果齐了之后)送给模型。它不会打断正在进行的工具或模型输出;要立刻停用 `interrupt`。
- `409 session_finishing`:会话刚好在收尾、收不了插话。等 1 秒重试(`Retry-After: 1`)。消息没有丢,也没有被悄悄当成新任务。
- `429 too_many_runs`:同时在跑的会话太多(插话不占名额)。
- `text` 非空,≤ 100000 字符。

### `GET /v1/sessions/:id/events`:事件流(SSE)

```bash
curl -N -H "Authorization: Bearer $TOKEN" "$URL/v1/sessions/$ID/events"
curl -N -H "Authorization: Bearer $TOKEN" "$URL/v1/sessions/$ID/events?after=12"   # 只要 seq > 12 的
```

每个事件一帧:

```
id: 7
event: tool.call
data: {"v":1,"id":"…","sessionId":"…","seq":7,"at":1700000000000,"turnId":"…","type":"tool.call","callId":"c1","name":"bash","input":{…},"effects":"unsafe"}

```

- `data` 是完整的 Hue 事件(JSON),格式见 `docs/packages/core.md` 第 4 节和 `packages/core/src/event.ts`。`event:` 就是事件的 `type`。
- **先回放后实时**:连上后先收到 store 里 `seq > after` 的历史,然后是实时事件,**不重复、不遗漏**。`after` 也可以用标准的 `Last-Event-ID` 请求头给。
- **`id:` 就是 `seq`**,只有会落盘的(durable)事件有。**没有 `id:` 的是临时事件**(`model.delta`、`tool.input.delta`、`tool.progress`):只在实时阶段出现,断线期间错过的补不回来,要拿完整内容等随后的 `model.message` / `tool.result`。
- 以 `:` 开头的行是注释(`: stream open`、每 15 秒的 `: keep-alive`),忽略即可。
- `event: ext` 且 `data.name == "gateway.error"`:gateway 层面的问题(agent 抛了异常、IM 回复发送失败),非 durable。
- 断线重连:记下最后一个 `id:`,重连时带上 `?after=<它>`。
- 会话不存在也能连:连上后等第一条消息。

**常见事件**(按一个典型 turn 的顺序):`turn.started` → `user.message` → `step.started` → `model.delta`\* → `model.message` → `tool.call` → `policy.decided` → [`input.requested` → `input.resolved`] → `tool.result` → …(下一步)… → `turn.ended`(`data.reason`:`stop` / `interrupted` / `error` / `length` / `stop_condition`)。

### `POST /v1/sessions/:id/interrupt`

在跑的会话 → `202 {"status":"interrupting"}`,turn 随后以 `turn.ended` `reason: "interrupted"` 结束(事件流里能看到)。没在跑 → `409 not_running`。正在等批准的请求会按取消处理。

### `GET /v1/sessions/:id`

```json
{ "sessionId": "…", "running": true, "lastSeq": 12, "pendingInputs": ["req-…"] }
```

`pendingInputs` 是正在等人回答的批准请求 ID。会话从没存在过 → 404。

### `POST /v1/sessions/:id/inputs/:requestId`:回答批准请求

agent 需要人确认时(比如 policy 对某个工具返回 `ask`),事件流里会出现:

```
event: input.requested
data: {…,"type":"input.requested","requestId":"req-1","callId":"c1","request":{"kind":"approval","prompt":"Allow bash? rm -rf build","detail":{…}}}
```

回答:

```bash
curl -X POST "$URL/v1/sessions/$ID/inputs/req-1" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"accept"}'                                   # 同意
  # -d '{"action":"decline","reason":"too risky"}'           # 拒绝,理由会告诉模型
  # -d '{"action":"cancel"}'                                 # 取消
  # -d '{"action":"accept","value":{"name":"ada"}}'          # 表单类请求(kind: "form")的答案放在 value 里
```

- 成功 `200 {"status":"answered"}`;请求不存在、已经被回答、已超时、或**不属于这个会话** → `404 no_such_request`。
- 超过 `inputTimeoutMs` 没人答,或者会话被打断,都按**取消**处理(工具不会执行)。
- 答案格式不对 → 400,**不会消耗掉**这个待回答的请求。

### `GET /healthz`

`200 {"ok":true}`。不鉴权,不查 `Host`,不暴露任何信息,给探活用。

## 3. 客户端示例

### 浏览器 / Node:读事件流

浏览器的 `EventSource` 不能设置 `Authorization` 头,所以用 `fetch` 读流(下面这段在测试里跑过,`packages/gateway/test/client-snippet.test.ts`):

```js
async function* watch(base, token, sessionId, after = 0, signal) {
  const res = await fetch(`${base}/v1/sessions/${sessionId}/events?after=${after}`, { headers: { authorization: `Bearer ${token}` }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const reader = res.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, i); buffer = buffer.slice(i + 2)
      const data = block.split('\n').find(l => l.startsWith('data: '))
      if (data) yield JSON.parse(data.slice(6))
    }
  }
}

// 用法:发任务,边看边处理,遇到批准请求就回答
const id = crypto.randomUUID(), headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
await fetch(`${base}/v1/sessions/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: '…' }) })
for await (const e of watch(base, token, id)) {
  if (e.type === 'model.delta') process.stdout.write(e.delta)
  if (e.type === 'input.requested') await fetch(`${base}/v1/sessions/${id}/inputs/${e.requestId}`, { method: 'POST', headers, body: JSON.stringify({ action: confirm(e.request.prompt) ? 'accept' : 'decline' }) })
  if (e.type === 'turn.ended') break
}
```

断线重连:记下最后一个 `e.seq`(临时事件的 `seq` 是 0,跳过),用 `watch(base, token, id, lastSeq)` 重新连。

> 先开事件流再发消息,或者发了消息再用 `after=0` 连——两种顺序都不会丢事件,因为连上时会先回放历史。

### 从网页直接调(浏览器跨域)

把网页的源加进 `allowedOrigins: ['https://app.example.com']`。gateway 会对这个源回 CORS 头并处理预检请求。**不要**把 token 写进网页源码;让你自己的后端换一个短期的、或者在同源反向代理里注入 `Authorization` 头(gateway 没有"token 换会话"的功能)。

## 4. 人工批准的完整流程

1. 部署时用 `agent: input => createAgent({ …, input, policy })`,policy 对需要确认的工具返回 `ask`(`@hue/policy` 的预设 `coding()` 会对未知命令 ask)。
2. 客户端在事件流里等 `input.requested`,把 `data.request.prompt` 展示给人。
3. 人决定后 `POST .../inputs/:requestId`。
4. 事件流里随后是 `input.resolved`,再是 `tool.result`(同意)或带 `synthetic: "denied"` 的 `tool.result`(拒绝/取消/超时)。

没有 `InputPort` 的 agent 遇到 `ask` 会直接把调用当作被拒绝处理(core 的行为),不会卡住。

## 5. 会话和并发的行为

- 同一个会话同一时刻只有一个 turn。再发消息 = 插话。
- 一个 gateway 实例里,在跑的会话、限流计数、事件订阅都在**内存**里。**不要在同一个 store 前面开多个 gateway 实例**:它们看不到彼此在跑什么,同一个会话可能被两边同时启动(runtime 靠 store 的 seq 主键让后写的失败,但客户端会看到莫名其妙的 `gateway.error`)。要扩容,按会话 ID 哈希路由到固定实例。
- gateway 重启不会丢会话(日志在 store 里),但在跑的 turn 会被打断收尾;下次对该会话发消息时 runtime 自动修复崩溃残留。

## 6. 接 IM / 外部系统:渠道

IM 平台是**它来调你**(webhook),所以不能用 Bearer token,用**签名**。

### 6.1 通用的签名 webhook(`webhookChannel`)

```ts
import { createGateway, webhookChannel } from '@hue/gateway'

createGateway({ …, channels: [webhookChannel({
  name: 'hook',                               // → POST /channels/hook
  secret: process.env.HOOK_SECRET!,           // ≥ 16 字符,双方共享
  send: async (conversation, text) => { await postToYourPlatform(conversation, text) },   // 每个 turn 结束时调用,发最终回复
})] })
```

**调用方**发请求:

```
POST /channels/hook
content-type: application/json
x-hue-timestamp: <Unix 秒>
x-hue-signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<原始请求体>") 的十六进制>

{"conversation":"U123","text":"帮我看看昨天的报错"}
```

Node(跑过,`client-snippet.test.ts`):

```js
import { createHmac } from 'node:crypto'
const body = JSON.stringify({ conversation: 'u1', text: 'hello' })
const timestamp = Math.floor(Date.now() / 1000)
const signature = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
const res = await fetch(`${url}/channels/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hue-timestamp': String(timestamp), 'x-hue-signature': signature }, body })
```

命令行(与 `sign()` 的输出逐字节对比过):

```bash
BODY='{"conversation":"u1","text":"hello"}'; TS=$(date +%s)
SIG="sha256=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
curl -X POST "$URL/channels/hook" -H 'content-type: application/json' -H "x-hue-timestamp: $TS" -H "x-hue-signature: $SIG" -d "$BODY"
```

Python 也是同样的算法:`hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()`(这一条我没跑过)。**签名必须对着你实际发出去的字节算**,不要先序列化一份算签名、再序列化另一份发送。

响应:`202 {"status":"started"|"steered","sessionId":"hook:u1"}`;不是消息的请求(缺字段、空文本)→ `200 {"status":"ignored"}`;签名/时间戳不对 → `401 bad_signature`(时间戳偏差超过 5 分钟也算不对)。

行为:
- 对话 `U123` 映射到会话 `hook:U123`。对话 ID 含奇怪字符时用哈希(`hook:h-<32 位十六进制>`),保证不同对话不撞。事件流 API 里用这个会话 ID。
- 对话里上一条还没答完又来一条 → 作为插话。
- 每个 turn 结束,`send(conversation, text)` 被调用一次,`text` 是最后一条模型消息的文本;turn 不是正常结束时末尾追加 `(stopped: <原因>)`;agent 出错时平台上只收到一句通用道歉。`send` 抛错不会影响 agent,会记成 `gateway.error` 事件。
- 渠道请求**不走 Bearer 鉴权**,走签名;同时也要通过 `Host` 检查(`allowedHosts` 要包含平台调用你的域名)。
- 限流在验签之后:没通过签名的请求不占配额。**对未鉴权流量(攻击者发垃圾)的限流请放在反向代理**。
- 窗口(5 分钟)内的重放不会被拦住(没有 nonce)。

### 6.2 为某个 IM 平台写一个渠道

实现 `Channel`(`src/types.ts`),四个成员:

```ts
const slackLike: Channel = {
  name: 'chat',                                           // POST /channels/chat
  verify(headers, rawBody) { /* 用平台的签名算法验 rawBody;返回 boolean */ },
  parse(body) { /* 平台事件 → { conversation, text };不是用户消息(心跳、机器人自己的回声)返回 undefined */ },
  async reply(conversation, text) { /* 调平台的发消息 API */ },
}
```

要注意的坑(**都是通用经验,我没有对着任何具体平台核实过**,写之前请读该平台的文档):
- 很多平台要求在几秒内应答 webhook,所以 gateway 总是立即回 202,agent 在后台跑,结果通过 `reply` 发回——正好符合。
- 一些平台第一次配置回调地址时会发一个"验证 URL"的挑战请求,需要原样回一个值。这种请求 `parse` 返回 `undefined` 只会得到 `{"status":"ignored"}`,不满足它;需要时在 gateway 前面的反向代理里处理,或者扩展 `Channel` 接口(目前没有)。
- **机器人自己发的消息会被平台再推回来**,`parse` 里必须过滤掉,否则会无限循环。
- 平台常有"重复投递"(超时重试):同一个事件可能来两次,会变成两条插话/两个 turn。目前没有去重。

## 7. 部署清单

- [ ] **token**:`openssl rand -hex 32` 生成,放环境变量/密钥管理,不进代码和日志。每个调用方一个 token(便于单独撤换;换 token 要重启)。
- [ ] **TLS**:gateway 自己不做 TLS。放在反向代理(nginx、Caddy、云负载均衡)后面,**对外只开 HTTPS**。Bearer token 走明文 HTTP 等于公开。
- [ ] **监听地址**:默认只绑 `127.0.0.1`,由同机的反向代理转发。绑 `0.0.0.0` 必须设 `allowedHosts` 和 token,且前面要有网络层的访问控制。
- [ ] **`allowedHosts`**:设成客户端实际使用的域名。配错的现象是 403 `forbidden_host`,消息里会写出被拒绝的主机名。
- [ ] **反向代理对 SSE 的设置**:关掉响应缓冲(gateway 已发 `X-Accel-Buffering: no`,nginx 会遵守;其他代理需要自己配),读超时要明显大于 15 秒(保活间隔),否则长时间没事件的流会被切断(客户端会带 `after` 重连,但会有抖动)。**这一条我没有在真实的代理后面验证过。**
- [ ] **沙箱**:agent 的工具在哪里执行才是真正的安全边界。对外开放的 gateway 应该配 `@hue/sandbox` 的 Docker 模式,不要用 local。policy 不是边界(见 `packages/policy/DECISIONS.md`)。
- [ ] **网络**:容器默认可联网,agent 能把工作目录里的东西发出去。有敏感内容就用 `network: 'none'`。
- [ ] **资源**:`maxRuns` 按你的模型额度和机器容量设;事件流上限 `maxStreams`;每个会话都在花钱。
- [ ] **单实例**:见第 5 节。
- [ ] **日志与监控**:设 `onError`;`GET /healthz` 做探活;事件日志(store)本身就是审计记录。回放工具:`examples/replay.ts`。
- [ ] **反向代理层的限流**:gateway 的限流是进程内、按已鉴权的主体算的,挡不住未鉴权的洪水。
- [ ] **关闭**:收到 SIGTERM 时调 `await gateway.close()`,在跑的会话会被打断收尾,订阅者收到最后的 `turn.ended`。

## 8. 已知限制

- 没有 WebSocket;没有会话列表接口;没有按会话的权限(所有 token 能访问所有会话);没有 token 过期。
- 慢客户端不做背压(`DECISIONS.md` 第 9 条)。
- 具体 IM 平台没有适配;渠道的重放和重复投递没有处理。
- 没有用真实浏览器、真实 IM、真实反向代理验证过;`examples/gateway.ts` 没有真正启动过。
