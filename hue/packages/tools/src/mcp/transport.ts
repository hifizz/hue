/** JSON-RPC 报文。params / result 的形状由 client.ts 和 tools.ts 各自断言，这里不展开。 */
export interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

export interface Reply {
  /** 对应请求的 JSON-RPC 响应；HTTP 返回了非 JSON-RPC 的错误页时没有。 */
  message?: RpcMessage
  /** 只有 HTTP 有：client 靠状态码和响应体判断对面是不是老 server。 */
  status?: number
  headers?: Headers
}

export interface RequestOptions {
  signal: AbortSignal
  /** 只对 HTTP 有意义；stdio 没有头这一层。 */
  headers?: Record<string, string>
  /** 这次请求的响应流里夹带的通知（进度）。 */
  onNotification?: (n: RpcMessage) => void
}

export interface Transport {
  readonly kind: 'stdio' | 'http'
  request(msg: RpcMessage, o: RequestOptions): Promise<Reply>
  notify(msg: RpcMessage, o?: { headers?: Record<string, string> }): Promise<void>
  close(): Promise<void>
  /** stdio：进程退出后下次请求会重新拉起，client 要重新探测对面是哪一代。 */
  onRestart?: () => void
}

/** 连接层面的失败：流断了、进程死了。和 server 回的 JSON-RPC 错误不同——这时请求有没有被执行是未知的。 */
export class TransportError extends Error {
  constructor(message: string) { super(message); this.name = 'TransportError' }
}

export const abortError = () => new DOMException('aborted', 'AbortError')
