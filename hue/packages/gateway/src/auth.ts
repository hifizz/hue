import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) { super(message) }
}

const digest = (s: string) => createHash('sha256').update(s).digest()
/** 先各自取摘要再比较：长度固定，不会因为长度不同提前返回，也不泄露 token 长度。 */
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

/** 返回主体名（给限流用，不是 token 本身），鉴权失败抛 401。 */
export function authenticate(headers: IncomingHttpHeaders, tokens: string[] | undefined): string {
  if (!tokens) return 'anonymous'
  const m = /^Bearer (.+)$/i.exec(String(headers.authorization ?? ''))
  // 对每个 token 都比较（不在第一个命中时就返回），耗时不随命中位置变化
  let hit = -1
  tokens.forEach((t, i) => { if (m && safeEqual(m[1]!, t)) hit = i })
  if (hit < 0) throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token', { 'www-authenticate': 'Bearer' })
  return `token-${hit}`
}

export const hostname = (host: string | undefined) => {
  const h = (host ?? '').toLowerCase()
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]!
}

export const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

/** DNS rebinding：恶意网页把自己的域名解析到 127.0.0.1，浏览器会带着它的域名当 Host 发来。不认识的 Host 一律拒绝。 */
export function checkHost(headers: IncomingHttpHeaders, allowed: string[]) {
  if (!allowed.includes(hostname(headers.host))) throw new HttpError(403, 'forbidden_host', `host "${hostname(headers.host)}" is not allowed`)
}

/** 浏览器跨域请求才带 Origin。没列入白名单的一律拒绝；返回应该回给浏览器的 CORS 源（没有就 undefined）。 */
export function checkOrigin(headers: IncomingHttpHeaders, allowed: string[]): string | undefined {
  const o = headers.origin
  if (o === undefined) return undefined
  if (!allowed.includes(o)) throw new HttpError(403, 'forbidden_origin', `origin "${o}" is not allowed`)
  return o
}

/** 固定窗口：每个主体每分钟 limit 个。简单、够用；窗口边界处最多放过 2 倍。 */
export function createLimiter(limit: number, now: () => number) {
  const w = new Map<string, { start: number; n: number }>()
  return (who: string) => {
    const t = now(), cur = w.get(who)
    if (!cur || t - cur.start >= 60_000) { w.set(who, { start: t, n: 1 }); if (w.size > 1000) for (const [k, v] of w) if (t - v.start >= 60_000) w.delete(k); return }
    if (++cur.n > limit) throw new HttpError(429, 'rate_limited', 'too many requests', { 'retry-after': String(Math.max(1, Math.ceil((cur.start + 60_000 - t) / 1000))) })
  }
}

// ───── 渠道签名：HMAC-SHA256(secret, `${timestamp}.${rawBody}`) ─────
export const sign = (secret: string, timestamp: number, rawBody: string) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
