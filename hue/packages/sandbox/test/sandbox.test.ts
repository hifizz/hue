import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'
import type { SandboxPort } from '@hue/core'
import { sandboxPortContract } from '@hue/core/contracts'
import { docker, local, type DockerOptions, type LocalOptions } from '../src/index.js'
import { MAX_CAPTURE } from '../src/exec.js'

const IMAGE = process.env.HUE_TEST_IMAGE ?? 'alpine:3' // 小、快；也顺便保证我们只依赖 busybox 就有的命令
const hostDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'hue-sb-')))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const textOf = (b: Uint8Array) => new TextDecoder().decode(b)

const dockerSkip = (() => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 }); return false } catch { return 'docker is not available (is Docker/OrbStack running?)' as const }
})()

interface Env { sb: SandboxPort; dir: string; /** 沙箱里看到的 root 路径 */ work: string; dispose?: () => Promise<void> }
interface Kind { name: string; skip: string | false; make(o?: { local?: Partial<LocalOptions>; docker?: Partial<DockerOptions> }): Promise<Env> }

const kinds: Kind[] = [
  { name: 'local', skip: false, async make(o) { const dir = hostDir(); return { sb: await local({ root: dir, ...o?.local }), dir, work: dir } } },
  { name: 'docker', skip: dockerSkip, async make(o) {
    const dir = hostDir(); const sb = await docker({ mount: dir, image: IMAGE, ...o?.docker })
    return { sb, dir, work: '/work', dispose: () => sb.dispose() }
  } },
]

async function using<T>(k: Kind, fn: (e: Env) => Promise<T>, o?: Parameters<Kind['make']>[0]): Promise<T> {
  const e = await k.make(o)
  try { return await fn(e) } finally { await e.dispose?.() }
}

// ═════════ core 的合同：两个实现都要过 ═════════
for (const k of kinds) {
  if (k.skip) { test(`${k.name}: sandboxPortContract`, { skip: k.skip }, () => {}); continue }
  const env = await k.make() // docker 是第一次 exec 才起容器，所以这里不贵；合同的 5 个用例共用一个
  sandboxPortContract(k.name, async () => env.sb, { workdir: env.work })
  after(async () => { await env.dispose?.() })
}

// ═════════ 两个实现共同的行为 ═════════
for (const k of kinds) {
  const t = (name: string, fn: () => Promise<void>) => test(`${k.name}: ${name}`, { skip: k.skip, timeout: 60_000 }, fn)

  t('路径逃逸：../、绝对路径、符号链接（读、写、cwd）都被拦住', () => using(k, async ({ sb, dir, work }) => {
    const outside = hostDir(); writeFileSync(join(outside, 'secret'), 's')
    symlinkSync(outside, join(dir, 'link'))
    const escapes = /escapes the sandbox root/
    await assert.rejects(sb.readFile(`../${basename(outside)}/secret`), escapes)
    await assert.rejects(sb.readFile(join(outside, 'secret')), escapes)
    await assert.rejects(sb.readFile('link/secret'), escapes)
    await assert.rejects(sb.writeFile('link/new', 'x'), escapes)
    await assert.rejects(sb.list('link'), escapes)
    await assert.rejects(sb.exec('true', { cwd: '..' }), escapes)
    assert.equal(existsSync(join(outside, 'new')), false)
    // root 里面的路径：相对、沙箱里的绝对路径都可以；不存在的新文件和新目录可以写
    await sb.writeFile('a/b/new.txt', 'ok'); assert.equal(textOf(await sb.readFile(`${work}/a/b/new.txt`)), 'ok')
    assert.equal(readFileSync(join(dir, 'a/b/new.txt'), 'utf8'), 'ok')
  }))

  t('exec 和文件接口看到的是同一份文件', () => using(k, async ({ sb, dir }) => {
    assert.equal((await sb.exec('echo from-shell > f.txt', {})).exitCode, 0)
    assert.equal(textOf(await sb.readFile('f.txt')), 'from-shell\n')
    await sb.writeFile('g.txt', '你好'); assert.equal((await sb.exec('cat g.txt', {})).stdout, '你好')
    assert.equal(statSync(join(dir, 'f.txt')).uid, process.getuid!(), 'shell 创建的文件归当前用户，不是 root')
  }))

  t('宿主环境变量（API key）在命令里看不到；显式传入的可以', () => using(k, async ({ sb }) => {
    process.env.HUE_TEST_SECRET = 'leak-me'
    try {
      assert.equal((await sb.exec('printf "[$HUE_TEST_SECRET]"', {})).stdout, '[]')
      assert.equal((await sb.exec('printf "$X"', { env: { X: 'y' } })).stdout, 'y')
    } finally { delete process.env.HUE_TEST_SECRET }
  }))

  t('超时杀掉整棵进程：后台子进程也不留，exec 很快返回', () => using(k, async ({ sb }) => {
    // 只杀 shell 时，活着的 sleep 还握着 stdout 管道，exec 要等它们结束才返回——所以耗时也是检查项。
    const t0 = Date.now()
    const r = await sb.exec('sleep 20 & echo $!; sleep 20', { timeoutMs: 400 })
    assert.equal(r.timedOut, true); assert.ok(Date.now() - t0 < 6000, `exec took ${Date.now() - t0}ms`)
    const pid = Number(r.stdout.trim()); assert.ok(pid > 1, JSON.stringify(r.stdout))
    await sleep(300)
    assert.equal((await sb.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`, {})).stdout.trim(), 'dead', `background process ${pid} survived`)
  }))

  t('取消同样杀整棵进程，并以 AbortError 结束', () => using(k, async ({ sb }) => {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 400)
    const t0 = Date.now()
    // 取消时拿不到 stdout，所以让命令把后台进程的 pid 写进文件，事后再查。
    await assert.rejects(sb.exec('sleep 20 & echo $! > bg.pid; sleep 20', { signal: ac.signal }), (e: any) => e?.name === 'AbortError')
    assert.ok(Date.now() - t0 < 6000)
    const pid = Number(textOf(await sb.readFile('bg.pid')).trim()); assert.ok(pid > 1)
    await sleep(300)
    assert.equal((await sb.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`, {})).stdout.trim(), 'dead', `background process ${pid} survived the abort`)
    await assert.rejects(sb.exec('true', { signal: AbortSignal.abort() }), (e: any) => e?.name === 'AbortError') // 一开始就已取消
  }))

  t('输出上限：超长输出被截断并标注，命令照常结束，不卡住也不爆内存', () => using(k, async ({ sb }) => {
    const t0 = Date.now()
    const r = await sb.exec('head -c 3000000 /dev/zero | tr "\\0" x; echo err >&2', {})
    assert.equal(r.exitCode, 0); assert.ok(Date.now() - t0 < 20_000)
    assert.ok(r.stdout.length <= MAX_CAPTURE + 100 && r.stdout.length > MAX_CAPTURE - 10, String(r.stdout.length))
    assert.match(r.stdout, /\[output truncated at 1000000 bytes\]/)
    assert.equal(r.stderr.trim(), 'err') // 另一个流不受影响
  }))

  t('多字节字符被切在包边界也不乱码', () => using(k, async ({ sb }) => {
    const r = await sb.exec('yes 你好 | head -n 100000', {})
    assert.equal(r.stdout.length, 300_000); assert.ok(!r.stdout.includes('�'))
  }))

  t('exec 的 cwd：相对路径和沙箱里的绝对路径都行', () => using(k, async ({ sb, dir, work }) => {
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'x'), '')
    assert.equal((await sb.exec('ls', { cwd: 'sub' })).stdout.trim(), 'x')
    assert.equal((await sb.exec('ls', { cwd: `${work}/sub` })).stdout.trim(), 'x')
  }))
}

test('local: allowOutsideRoot: true 时不检查路径', async () => {
  const outside = hostDir(); writeFileSync(join(outside, 'f'), 'out')
  const sb = await local({ root: hostDir(), allowOutsideRoot: true })
  assert.equal(textOf(await sb.readFile(join(outside, 'f'))), 'out')
})

test('local: 构造时指定的 env 每次 exec 都带上，调用方的优先', async () => {
  const sb = await local({ root: hostDir(), env: { A: '1', B: '1' } })
  assert.equal((await sb.exec('printf "$A$B"', { env: { B: '2' } })).stdout, '12')
})

// ═════════ docker 特有 ═════════
const d = (name: string, fn: () => Promise<void>) => test(`docker: ${name}`, { skip: dockerSkip, timeout: 60_000 }, fn)
const ps = (name: string) => execFileSync('docker', ['ps', '-a', '-q', '--filter', `name=${name}`]).toString().trim()
const dk = kinds[1]!

d('容器第一次 exec 才启动，dispose 才删除，可重复 dispose，之后不能再用', async () => {
  const sb = await docker({ mount: hostDir(), image: IMAGE })
  assert.equal(ps(sb.containerName), '')
  await sb.exec('true', {}); await sb.exec('true', {}) // 复用同一个容器
  assert.notEqual(ps(sb.containerName), ''); assert.equal(execFileSync('docker', ['ps', '-a', '-q', '--filter', `name=${sb.containerName}`]).toString().trim().split('\n').length, 1)
  await sb.dispose(); await sb.dispose()
  assert.equal(ps(sb.containerName), '')
  await assert.rejects(sb.exec('true', {}), /disposed/)
})

d('不是 root，是宿主用户；只看得到挂载的目录', () => using(dk, async ({ sb }) => {
  const other = hostDir(); writeFileSync(join(other, 'host-only'), 'x')
  assert.equal((await sb.exec('id -u', {})).stdout.trim(), String(process.getuid!()))
  assert.notEqual((await sb.exec('id -u', {})).stdout.trim(), '0')
  assert.notEqual((await sb.exec(`ls ${other}`, {})).exitCode, 0, '宿主上别的目录在容器里不存在')
  assert.equal((await sb.exec('pwd', {})).stdout.trim(), '/work')
}))

d('网络：默认能联网（有 eth0），network: "none" 时只剩 lo', async () => {
  await using(dk, async ({ sb }) => { assert.match((await sb.exec('ls /sys/class/net', {})).stdout, /eth0/) })
  await using(dk, async ({ sb }) => { assert.equal((await sb.exec('ls /sys/class/net', {})).stdout.trim(), 'lo') }, { docker: { network: 'none' } })
})

d('内存限制生效（cgroup v2 才检查）', () => using(dk, async ({ sb }) => {
  const r = await sb.exec('cat /sys/fs/cgroup/memory.max 2>/dev/null || echo na', {})
  if (r.stdout.trim() !== 'na') assert.equal(r.stdout.trim(), String(64 * 1024 * 1024))
}, { docker: { memory: '64m' } }))

d('没有 docker 可执行文件 / 起不来：exec 得到清楚的错误，不是挂住', async () => {
  const sb = await docker({ mount: hostDir(), bin: 'definitely-not-docker' })
  await assert.rejects(sb.exec('true', {}), /cannot run "definitely-not-docker"/)
})

d('镜像不存在：错误里带 docker 的原话，之后可以重试', async () => {
  const sb = await docker({ mount: hostDir(), image: 'hue-no-such-image:0' })
  await assert.rejects(sb.exec('true', {}), /docker run failed/)
  await assert.rejects(sb.exec('true', {}), /docker run failed/) // 失败没有被缓存成永久失败
})
