import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authenticate, checkHost, checkOrigin, createLimiter, hostname, HttpError, safeEqual } from '../src/auth.js'
import { createHub } from '../src/hub.js'
import { createInputs } from '../src/inputs.js'

test('hostname：去掉端口、转小写、IPv6 带方括号', () => {
  assert.equal(hostname('LocalHost:3000'), 'localhost'); assert.equal(hostname('[::1]:8080'), '[::1]'); assert.equal(hostname('[::1]'), '[::1]'); assert.equal(hostname('a.b'), 'a.b'); assert.equal(hostname(undefined), '')
})

test('safeEqual / authenticate / checkHost / checkOrigin', () => {
  assert.ok(safeEqual('abc', 'abc')); assert.ok(!safeEqual('abc', 'abd')); assert.ok(!safeEqual('abc', 'abcd')); assert.ok(!safeEqual('', 'a'))
  assert.equal(authenticate({}, undefined), 'anonymous')
  assert.equal(authenticate({ authorization: 'Bearer bbbbbbbbbbbbbbbbbbbb' }, ['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb']), 'token-1')
  assert.throws(() => authenticate({}, ['aaaaaaaaaaaaaaaaaaaa']), (e: unknown) => e instanceof HttpError && e.status === 401)
  assert.throws(() => checkHost({ host: 'x.com' }, ['y.com']), /not allowed/); assert.doesNotThrow(() => checkHost({ host: 'y.com:1' }, ['y.com'])); assert.throws(() => checkHost({}, ['y.com']))
  assert.equal(checkOrigin({}, []), undefined); assert.equal(checkOrigin({ origin: 'https://a' }, ['https://a']), 'https://a'); assert.throws(() => checkOrigin({ origin: 'https://a' }, []))
})

test('限流器：窗口内超出才抛；换主体互不影响；窗口结束重新计；表不会无限长', () => {
  let t = 0; const limit = createLimiter(2, () => t)
  limit('a'); limit('a'); assert.throws(() => limit('a'), (e: unknown) => e instanceof HttpError && e.status === 429 && e.headers['retry-after'] === '60')
  limit('b'); t = 59_000; assert.throws(() => limit('a'), (e: unknown) => (e as HttpError).headers['retry-after'] === '1')
  t = 60_000; limit('a')
  for (let i = 0; i < 1500; i++) limit(`who-${i}`)
  t = 200_000; limit('fresh')
})

test('hub：按会话隔离；取消订阅后不再收到；回调里取消订阅不影响同一次发布', () => {
  const hub = createHub(), got: string[] = []
  const e = (id: string) => ({ sessionId: id }) as never
  const off1 = hub.subscribe('s', () => { got.push('1'); off2() }), off2 = hub.subscribe('s', () => got.push('2'))
  hub.subscribe('other', () => got.push('other'))
  hub.publish('s', e('s')); assert.deepEqual(got, ['1', '2'])
  off1(); hub.publish('s', e('s')); assert.deepEqual(got, ['1', '2'])
})

test('inputs：答案要对得上会话；超时、abort、cancelAll 都变成 cancel；已经 abort 的请求立刻 cancel', async () => {
  const inputs = createInputs(40), req = (requestId: string, sessionId = 's') => ({ kind: 'approval' as const, prompt: 'p', requestId, sessionId })
  const p = inputs.port.request(req('r1'), new AbortController().signal)
  assert.deepEqual(inputs.pendingFor('s'), ['r1']); assert.equal(inputs.answer('other', 'r1', { action: 'accept' }), false)
  assert.equal(inputs.answer('s', 'r1', { action: 'accept', value: 1 }), true); assert.deepEqual(await p, { action: 'accept', value: 1 }); assert.deepEqual(inputs.pendingFor('s'), [])
  assert.deepEqual(await inputs.port.request(req('r2'), new AbortController().signal), { action: 'cancel' }, '超时')
  const ac = new AbortController(); const q = inputs.port.request(req('r3'), ac.signal); ac.abort(); assert.deepEqual(await q, { action: 'cancel' })
  const done = new AbortController(); done.abort(); assert.deepEqual(await inputs.port.request(req('r4'), done.signal), { action: 'cancel' }); assert.deepEqual(inputs.pendingFor('s'), [])
  const long = createInputs(60_000), w = long.port.request(req('r5'), new AbortController().signal); long.cancelAll(); assert.deepEqual(await w, { action: 'cancel' })
})
