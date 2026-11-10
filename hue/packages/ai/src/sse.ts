/**
 * 第一层：字节 → SSE 消息。
 *
 * HTTP 流式响应是一串字节，按"网络包"到达，包的边界和事件的边界毫无关系：
 * 一个事件可能被切成三个包，一个中文字的 3 个字节可能分在两个包里，
 * 一个包里也可能同时有两个事件。所以必须自己攒缓冲区，凑够一个完整事件再往外给。
 *
 * SSE 格式（Anthropic 用的就是它）：
 *   event: content_block_delta
 *   data: {"type":"content_block_delta",...}
 *   <空行>            ← 空行表示一个事件结束
 */
export interface SSEMessage { event?: string; data: string }

export async function* parseSSE(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<SSEMessage> {
  // stream: true 让解码器记住"上一个包末尾没收完的多字节字符"，下一个包来了再接上。
  // 如果每个包单独 decode，被切开的中文或 emoji 会变成 �。
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const packet of bytes) {
    buffer += decoder.decode(packet, { stream: true })
    let sep: RegExpExecArray | null
    while ((sep = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, sep.index)
      buffer = buffer.slice(sep.index + sep[0].length)
      const message = parseBlock(block)
      if (message) yield message
    }
  }
  // 流结束时 buffer 里剩下的是"没有以空行收尾"的半个事件。按 SSE 规范直接丢弃：
  // 它的 JSON 很可能是截断的。上层会因为没看到 message_stop 而报"流提前结束"。
}

function parseBlock(block: string): SSEMessage | undefined {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue // ':' 开头是注释（服务端常用来保活）
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { event, data: data.join('\n') } : undefined
}
