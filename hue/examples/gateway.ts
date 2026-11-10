/**
 * 把 agent 放到 HTTP 后面:别的程序(网页、脚本、IM 机器人)通过 HTTP 发任务、看事件流、批准工具调用。
 *
 *   cd hue && HUE_GATEWAY_TOKEN=<至少16个字符> npx tsx --env-file=.env.local examples/gateway.ts <仓库目录>
 *
 * 接口和部署注意事项见 packages/gateway/INTEGRATION.md。
 * 默认在 Docker 里直接挂载 <仓库目录>(不像 agent.ts 那样克隆一份副本:改动会落在原目录上);
 * HUE_SANDBOX=local 不隔离,策略是 presets.coding(),需要确认的命令会变成 input.requested 事件,等 HTTP 回答。
 * HUE_HOST / HUE_PORT 控制监听(默认 127.0.0.1:8787);监听别的地址必须设 HUE_ALLOWED_HOSTS=域名[,域名]。
 * 设了 HUE_WEBHOOK_SECRET 会多开一个 POST /channels/hook;HUE_WEBHOOK_REPLY_URL 是把回复 POST 回去的地方(不设就只打印)。
 */
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { chain, foldToolResults, summarize } from '@hue/context'
import { createGateway, sign, webhookChannel } from '@hue/gateway'
import { presets } from '@hue/policy'
import { createAgent } from '@hue/runtime'
import { docker, local } from '@hue/sandbox'
import { sqliteStore } from '@hue/store'
import { codingTools } from '@hue/tools'
import { INSTRUCTIONS, modelFromEnv } from './agent.js'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2], token = process.env.HUE_GATEWAY_TOKEN
  if (!dir || !token) { console.error('用法: HUE_GATEWAY_TOKEN=<至少16个字符> npx tsx --env-file=.env.local examples/gateway.ts <仓库目录>'); process.exit(2) }
  const mode = process.env.HUE_SANDBOX ?? 'docker'
  if (mode !== 'docker' && mode !== 'local') { console.error(`HUE_SANDBOX 只能是 docker 或 local,收到 "${mode}"`); process.exit(2) }

  const store = sqliteStore(process.env.HUE_DB ?? './hue.db')
  const sandbox = mode === 'docker' ? await docker({ mount: dir, image: process.env.HUE_IMAGE, network: process.env.HUE_NETWORK }) : await local({ root: dir })
  const llm = modelFromEnv()

  const secret = process.env.HUE_WEBHOOK_SECRET, replyUrl = process.env.HUE_WEBHOOK_REPLY_URL
  const channels = secret ? [webhookChannel({
    name: 'hook', secret,
    async send(conversation, text) {
      if (!replyUrl) return void console.log(`[hook → ${conversation}] ${text}`)
      const body = JSON.stringify({ conversation, text }), ts = Math.floor(Date.now() / 1000)
      const r = await fetch(replyUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hue-timestamp': String(ts), 'x-hue-signature': sign(secret, ts, body) }, body })
      if (!r.ok) throw new Error(`reply endpoint answered HTTP ${r.status}`)
    },
  })] : []

  const gateway = createGateway({
    store, tokens: [token], channels,
    allowedHosts: process.env.HUE_ALLOWED_HOSTS?.split(','),
    onError: e => appendFileSync('gateway-errors.log', `${new Date().toISOString()} ${(e as Error).stack ?? e}\n`),
    // gateway 把自己的 InputPort 交给这个工厂:agent 要人批准时,请求经事件流发出去,答案从 HTTP 回来
    agent: input => createAgent({
      model: llm, store, instructions: INSTRUCTIONS, tools: codingTools(), sandbox, input, maxSteps: 40,
      policy: mode === 'docker' ? presets.yolo() : presets.coding(),
      context: chain(foldToolResults(), summarize({ model: llm })),
    }),
  })
  const { url } = await gateway.listen(Number(process.env.HUE_PORT ?? 8787), process.env.HUE_HOST ?? '127.0.0.1')
  console.log(`gateway 监听 ${url}(沙箱 ${mode},工作目录 ${dir})\n发消息: curl -H "Authorization: Bearer $HUE_GATEWAY_TOKEN" -H 'content-type: application/json' -d '{"text":"..."}' ${url}/v1/sessions/demo/messages`)
  const stop = async () => { await gateway.close(); if ('dispose' in sandbox) await (sandbox as { dispose(): Promise<void> }).dispose(); store.close(); process.exit(0) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
