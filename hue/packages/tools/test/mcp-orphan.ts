/** 起一个不听话的 mock server，连上之后不 close 就直接退出本进程：测"进程退出时子进程被清理"。 */
import { mcp } from '../src/mcp/index.js'
import { SERVER, TSX } from './mcp-helpers.js'

const server = mcp.stdio(process.execPath, ['--import', TSX, SERVER, JSON.stringify({ ignoreEof: true })], { name: 'orphan', onStderr: l => { if (l.startsWith('pid:')) console.log(l) } })
await server.tools!({ sessionId: 's', turnId: 't', input: { role: 'user', content: [] }, signal: new AbortController().signal })
setTimeout(() => process.exit(0), 100)
