/** 作为子进程跑的 mock MCP server：stdin 一行一条 JSON-RPC，选项从 argv[2] 的 JSON 读。 */
import { createInterface } from 'node:readline'
import type { RpcMessage } from '../src/mcp/transport.js'
import { createMock } from './mcp-mock.js'

const opts = JSON.parse(process.argv[2] ?? '{}')
const mock = createMock(opts)
process.stderr.write(`pid:${process.pid}\n`)
let waiting: RpcMessage['id']
createInterface({ input: process.stdin }).on('line', line => {
  process.stderr.write(`recv:${line}\n`)
  const msg = JSON.parse(line)
  if (msg.id === 'srv1') { // 客户端对我们主动发的请求的回应
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: waiting, result: { content: [{ type: 'text', text: `client answered: ${msg.error?.message ?? JSON.stringify(msg.result)}` }] } })}\n`); return
  }
  if (msg.method === 'notifications/cancelled') process.stderr.write(`cancelled:${msg.params.requestId}\n`)
  for (const out of mock.handle(msg)) {
    if (out.type === 'send') process.stdout.write(`${JSON.stringify(out.message)}\n`)
    else if (out.type === 'die') process.exit(3)
    else if (out.type === 'request') { waiting = out.then; process.stdout.write(`${JSON.stringify(out.message)}\n`) }
  }
})
process.on('SIGTERM', () => { process.stderr.write('got-sigterm\n'); if (!opts.ignoreTerm) process.exit(0) })
if (opts.ignoreEof) setInterval(() => {}, 1000)
else process.stdin.on('end', () => process.exit(0))
