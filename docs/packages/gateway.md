# @hue/gateway

## 职责
把一个 agent 放到 HTTP 后面:客户端发任务、订阅事件流、插话、打断、批准工具调用;外加一个带签名的 webhook 渠道接 IM。

## 不做
不跑 agent 的逻辑(那是 runtime);不决定工具能不能执行(那是 policy);不存数据(事件日志在 store)。不依赖 `@hue/runtime`,agent 以结构类型 `AgentLike` 传入。

## 接口(已实现,代码 `hue/packages/gateway`)
```ts
createGateway({ store, tokens, agent: input => createAgent({ …, input }), channels }): Gateway
interface Gateway { handler(req, res); listen(port?, host?); close(); inputPort: InputPort }
webhookChannel({ name, secret, send }): Channel
```
HTTP:`POST /v1/sessions/:id/messages`、`GET …/events`(SSE)、`POST …/interrupt`、`POST …/inputs/:requestId`、`GET /v1/sessions/:id`、`POST /channels/:name`、`GET /healthz`。完整说明、示例和部署清单:`hue/packages/gateway/INTEGRATION.md`。

## 关键问题
- DONE: 推送方式——只做 SSE + POST,不做 WebSocket(`hue/packages/gateway/DECISIONS.md` 第 1 条)。
- DONE: 回放与实时的衔接——先订阅再回放、按 seq 去重(第 4 条)。依赖"agent 先落盘再 yield"。
- DONE: 人工批准走 HTTP——gateway 实现 core 的 `InputPort`(第 7 条)。
- DONE: 浏览器侧攻击——`Host` / `Origin` 白名单挡 DNS rebinding(第 6 条)。
- TODO(deep): 慢客户端的背压——积压多少算慢、慢了丢事件还是断开(第 9 条,没做)。
- TODO(deep): 多租户——按会话的所有权、token 过期与轮换;现在所有 token 能访问所有会话。
- TODO(deep): 多实例——在跑的会话、限流、订阅都在进程内存里,不能在同一个 store 前开多个实例。
- TODO(verify): 具体 IM 平台(Slack、飞书、Telegram…)的签名算法、事件格式、验证 URL 的挑战请求、重复投递——都没有核实,也没有适配。
- TODO(verify): 其他 harness 的网关/接入层怎么做(Pi、Claude Code 的 SDK 与 headless 模式、Mastra server)——设计时没有对照过。

## 结论
骨架已实现,取舍见该包 DECISIONS.md。设计页原来只有 `deferred.md` 里的一行,**没有任务书**,所以接口是实现时自己定的,没有先走"设计页 → 评审"这一步。
- 事件流是 Hue 事件原样转发(不另造格式):客户端看到的就是日志里的东西,`examples/replay.ts` 和 gateway 用同一份数据。
- 默认安全:必须有 token;不认识的 Host / Origin 拒绝;各种上限;内部错误不外泄。
- 没做:WebSocket、会话列表、TLS、按会话权限、背压、具体 IM 平台适配。没有用真实模型、浏览器、IM、反向代理验证过。

## 验收
一个外部客户端只靠 HTTP 完成:发任务 → 看事件流 → 批准一次工具调用 → 打断;一个签名的 webhook 请求能得到回复。(机制已有测试覆盖,包括真实 runtime + policy + sqlite 的端到端;真实模型、真实浏览器、真实 IM 平台下还没验证。)

## 对应 JD
接入层、服务化、人在回路

## 博客素材
- SSE 回放与实时衔接的两种竞态(回放比实时慢时:读之前卡住 / 读完快照再卡住)和各自靠什么挡住。
- 为什么 webhook 要"先验签再限流"。
- 把 `InputPort` 变成 HTTP 请求/响应:挂起、超时、打断都按取消处理。
