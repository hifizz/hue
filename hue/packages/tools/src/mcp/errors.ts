/** server 回的 JSON-RPC 错误（或 HTTP 错误页）。和 TransportError 不同：这说明请求到了 server，只是被拒绝了。 */
export class McpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'McpError' }
}

// 规范为 MCP 保留的错误码（-32020 ~ -32099）
export const HEADER_MISMATCH = -32020
export const MISSING_CAPABILITY = -32021
export const UNSUPPORTED_VERSION = -32022
