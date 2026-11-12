# ADR-019 gateway 用 SSE + POST，不做 WebSocket
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/gateway
- 来源标记：无 `DECIDE:`。`docs/packages/deferred.md` 只有一行"HTTP / WebSocket / IM 接入"；gateway DECISIONS 开头说明这个包没有设计页和任务书，设计是实现时自己定的

## 问题
事件怎么推给客户端？

## 候选
1. 只做 SSE（事件流）+ 普通 POST（发消息、插话、打断、批准）。
2. WebSocket。
3. 两者都做。

## 各家怎么做（附出处）
没有对照过任何别的 harness `TODO(verify)`。

## 决定
选 1。Hue 的事件流是单向的（agent → 客户端），客户端的动作是离散请求，不需要双向长连接。SSE 是普通 HTTP：有 `Last-Event-ID` 续传、穿得过大多数代理、`curl` 就能看。Node 没有内置 WebSocket 服务端，手写要自己做握手、掩码、分片、ping/pong。

相关决定（gateway DECISIONS 第 3、4 条）：
- 发消息一个接口 `POST .../messages`：会话在跑就插话，不在跑就开始，客户端不用先查状态。
- 事件流先订阅（回放期间的实时事件攒进缓冲）、再读历史、读完同步地冲掉缓冲并切到实时；durable 事件按 `seq` 去重。这依赖 agent 用同一个 store 并先写后发。

## 代价
浏览器原生 `EventSource` 不能带 `Authorization` 头，网页端要用 `fetch` 读流或在同源反向代理里注入头。HTTP/1.1 下每个标签页占一个连接。断线重连窗口里的 delta 丢了（没有 `seq`），要靠随后的 `model.message` 拿完整文本。

## 何时要改
要做双向低延迟的东西（语音、实时协作编辑）时。

## 如何验证（eval / 测试）
- 两种慢回放测试（读之前卡住靠去重；读完快照再卡住靠缓冲）；两条同时到的消息一定是一条 `started` 一条 `steered`。
- **没有用真实浏览器、IM、反向代理验证过**；`examples/gateway.ts` 没真正启动过；无具体 IM 平台适配。
