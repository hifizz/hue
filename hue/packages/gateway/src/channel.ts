import { safeEqual, sign } from './auth.js'
import type { Channel } from './types.js'

export interface WebhookChannelOptions {
  /** 路由是 POST /channels/<name>。 */
  name: string
  /** 和平台（或你自己的中转服务）共享的密钥。 */
  secret: string
  /** 把 agent 的回复发回去。 */
  send(conversation: string, text: string): Promise<void>
  /** 时间戳允许的偏差，默认 5 分钟。 */
  toleranceMs?: number
  now?: () => number
}

/**
 * 通用的"带签名的 JSON webhook"渠道，也是接 Slack / 飞书 / Telegram 等的模板：
 * 各平台的签名算法和事件格式不同，所以真正接哪个平台，就是照这个写一个 verify（平台的签名）+ parse（平台的事件）+ reply（平台的发消息接口）。
 *
 * 请求：POST，JSON 体 `{ "conversation": "...", "text": "..." }`，
 * 头 `x-hue-timestamp`（秒）和 `x-hue-signature: sha256=HMAC(secret, "<timestamp>.<原始请求体>")`。
 * 时间戳限制了重放的窗口，但窗口内的重放不会被拦住（没有 nonce）。
 */
export function webhookChannel(o: WebhookChannelOptions): Channel {
  const now = o.now ?? Date.now, tolerance = o.toleranceMs ?? 5 * 60_000
  if (o.secret.length < 16) throw new Error('webhook secret must be at least 16 characters')
  return {
    name: o.name,
    verify(headers, rawBody) {
      const ts = Number(headers['x-hue-timestamp']), sig = headers['x-hue-signature']
      if (!Number.isFinite(ts) || typeof sig !== 'string' || Math.abs(now() - ts * 1000) > tolerance) return false
      return safeEqual(sig, sign(o.secret, ts, rawBody))
    },
    parse(body) {
      const b = body as { conversation?: unknown; text?: unknown } | null
      if (!b || typeof b.conversation !== 'string' || typeof b.text !== 'string') return undefined
      const conversation = b.conversation.trim(), text = b.text.trim()
      return conversation && conversation.length <= 200 && text ? { conversation, text } : undefined
    },
    reply: o.send,
  }
}
