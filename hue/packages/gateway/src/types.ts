import type { IncomingHttpHeaders } from 'node:http'
import type { EventStore, HueEvent } from '@hue/core'

/**
 * gateway 需要的 agent 的形状。结构类型而不是 import @hue/runtime：包之间不互相依赖，
 * runtime 的 Agent 恰好满足它（run 的返回值多出的 RunResult 被忽略）。
 */
export interface AgentLike {
  run(input: string, opts: { sessionId: string; signal?: AbortSignal }): AsyncGenerator<HueEvent, unknown>
  steer(sessionId: string, input: string): boolean
  interrupt(sessionId: string): boolean
}

/** IM / webhook 渠道。平台来调我们，所以鉴权由渠道自己做（签名），不走 bearer token。 */
export interface Channel {
  /** 小写字母、数字、连字符；路由是 POST /channels/<name>。 */
  readonly name: string
  /** 校验请求确实来自平台。rawBody 是未解析的原文（签名算的是它）。 */
  verify(headers: IncomingHttpHeaders, rawBody: string): boolean
  /** 返回 undefined 表示这条请求不用处理（心跳、非消息事件），gateway 回 200 并忽略。 */
  parse(body: unknown): { conversation: string; text: string } | undefined
  /** 每个 turn 结束时把最终回复发回平台。抛错会被记成 gateway.error 事件，不影响 agent。 */
  reply(conversation: string, text: string): Promise<void>
}

export interface GatewayOptions {
  /** 直接给 agent，或者给一个工厂：gateway 把自己的 InputPort 交给你，传给 createAgent({ input })——避免 agent 和 gateway 互相等对方。 */
  agent: AgentLike | ((input: import('@hue/core').InputPort) => AgentLike)
  /** 回放 SSE 用：从这里读历史，再接实时。必须是 agent 写入的同一个 store。 */
  store: EventStore
  /** Bearer token 列表。不给就必须显式 insecureNoAuth: true。 */
  tokens?: string[]
  /** 关掉鉴权。只用于本机开发；监听非回环地址时 listen() 会拒绝。 */
  insecureNoAuth?: boolean
  /** 允许的 Host 主机名（不含端口），挡 DNS rebinding。默认 localhost / 127.0.0.1 / [::1]。部署到域名上必须加。 */
  allowedHosts?: string[]
  /** 允许的浏览器 Origin。默认空：带 Origin 头的请求一律拒绝（非浏览器客户端不带）。 */
  allowedOrigins?: string[]
  channels?: Channel[]
  /** 请求体上限，默认 1 MiB。 */
  maxBodyBytes?: number
  /** 每个主体（token 或渠道）每分钟最多多少个请求，默认 120。 */
  rateLimitPerMinute?: number
  /** 同时在跑的会话数上限，默认 8。 */
  maxRuns?: number
  /** 等待人批准的最长时间，默认 10 分钟，超时按取消处理。 */
  inputTimeoutMs?: number
  /** SSE 保活间隔，默认 15 秒。 */
  keepAliveMs?: number
  /** 同时打开的事件流上限，默认 100。 */
  maxStreams?: number
  /** close() 最多等在跑的会话多久，默认 10 秒。 */
  closeTimeoutMs?: number
  /** 意料之外的内部错误（回给客户端的永远只是 500）。 */
  onError?: (err: unknown) => void
  now?: () => number
}

export interface Gateway {
  /** 挂到任何 http.Server / 框架上。 */
  handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void
  listen(port?: number, host?: string): Promise<{ url: string; port: number }>
  /** 停止接收、结束所有 SSE、打断在跑的会话并等它们收尾。 */
  close(): Promise<void>
  /** 把它传给 createAgent({ input })：agent 需要人批准时，请求经事件流发给客户端，答案从 HTTP 回来。 */
  inputPort: import('@hue/core').InputPort
}
