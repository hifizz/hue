/**
 * 连一个真实的 MCP server，看它说哪一代协议、有哪些工具，可选地调一个工具。
 *
 *   cd hue
 *   npx tsx examples/mcp-smoke.ts stdio npx -y @modelcontextprotocol/server-filesystem /some/dir
 *   npx tsx examples/mcp-smoke.ts http https://example.com/mcp --header "Authorization: Bearer …"
 *   npx tsx examples/mcp-smoke.ts --call list_directory '{"path":"/some/dir"}' stdio npx -y @modelcontextprotocol/server-filesystem /some/dir
 *
 * server 要更多输入（input_required）时，会在终端里问你要不要填表单。
 */
import { createInterface } from 'node:readline/promises'
import { mcp } from '@hue/tools'

const argv = process.argv.slice(2)
let call: [string, Record<string, unknown>] | undefined
if (argv[0] === '--call') { call = [argv[1]!, JSON.parse(argv[2] ?? '{}')]; argv.splice(0, 3) }
const [kind, ...rest] = argv
if (kind !== 'stdio' && kind !== 'http') { console.error('用法: mcp-smoke.ts [--call 工具名 \'{"参数":…}\'] stdio <命令> [参数…] | http <url> [--header "K: V"]'); process.exit(2) }

const headers: Record<string, string> = {}
for (let i = rest.indexOf('--header'); i >= 0; i = rest.indexOf('--header')) { const [k, ...v] = rest.splice(i, 2)[1]!.split(':'); headers[k!.trim()] = v.join(':').trim() }
const server = kind === 'stdio'
  ? mcp.stdio(rest[0]!, rest.slice(1), { name: 'smoke', onStderr: l => console.error(`[server] ${l}`) })
  : mcp.http(rest[0]!, { name: 'smoke', headers, onWarning: w => console.warn(w) })
const signal = AbortSignal.timeout(60_000)
const ctx = { sessionId: 'smoke', turnId: 't', input: { role: 'user' as const, content: [] }, signal }
try {
  const instructions = await server.instructions!(ctx)
  const tools = await server.tools!(ctx)
  console.log(`协议: ${server.protocol()}\n说明: ${instructions ?? '(无)'}\n工具 ${tools.length} 个:`)
  for (const t of tools) console.log(`  ${t.name}  [${t.effects}]  ${t.description.split('\n')[0]!.slice(0, 80)}`)
  if (call) {
    const tool = tools.find(t => t.name === `smoke__${call![0]}`)
    if (!tool) throw new Error(`没有工具 ${call[0]}`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const out = await tool.execute(tool.parse!(call[1] as never) as never, {
      signal, sessionId: 'smoke', turnId: 't', callId: 'c', progress: d => console.log('进度', d),
      requestInput: async r => {
        if (r.kind !== 'form') return { action: 'cancel' }
        console.log(r.prompt, JSON.stringify(r.schema))
        if (!/^y/i.test(await rl.question('填写吗？[y/N] '))) return { action: 'decline' }
        return { action: 'accept', value: JSON.parse(await rl.question('JSON: ')) }
      },
    })
    rl.close()
    console.log(`\n结果${out.isError ? '（错误）' : ''}:\n${out.content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')}`)
  }
} finally { await server.close() }
