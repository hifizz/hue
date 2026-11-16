# @hue/sandbox

core 的 `SandboxPort` 的三个实现：本地进程 `local()`、Docker 容器 `docker()`、macOS Seatbelt（Linux bubblewrap，未验证）`seatbelt()`。内置工具的所有 I/O 都经过它。

```ts
import { local, docker, seatbelt } from '@hue/sandbox'

const a = await local({ root: '/path/to/repo' })                  // 路径锁 + 环境变量白名单；命令不隔离
const b = await docker({ mount: '/path/to/repo', image: 'node:22' }) // 容器里跑命令，只看得到 mount
const c = await seatbelt({ root: '/path/to/repo' })               // 真实目录 + OS 门禁：写 root 外被拒，网络默认全断
await c.exec('npm test', { timeoutMs: 60_000 })
```

| | `local` | `docker` | `seatbelt` |
|---|---|---|---|
| 文件接口（read/write/list） | 路径必须在 root 内，含符号链接 | 同左，经挂载目录，容器里是 `/work` | 同左（路径锁之外还有 OS 门禁） |
| `exec` | 以你的用户身份，**能 `cd /` 出去** | 在容器里，只看得到挂载目录，非 root | Seatbelt：写 root 外被拒，读默认允许，`denyRead` 可拦 `~/.ssh` |
| 环境变量 | 不继承宿主，最小集合 + 传入的 | 同左 | 同左（sandbox-runtime 不管 env，白名单是我们自己叠的） |
| 超时 / 取消 | 杀整个进程组 | 杀容器里带标记的所有进程 | 只杀直接子进程，**后台进程会残留**（detached 会让 Seatbelt 失效） |
| 输出 | 每个流最多 1 MB，超出标注 | 同左 | 同左 |
| 网络 | 宿主的 | 默认联网（`bridge`），`network: 'none'` 断网 | 默认全断，`allowedDomains` 按域名放行（实测 npmjs 通、example 断） |
| 在哪跑 | 真实目录 | git 副本（容器里） | 真实目录 |

容器第一次 `exec` 才启动，崩溃时靠 TTL（默认 4 小时）自己退出。`seatbelt` 的 `SandboxManager` 是全局单例：一个进程只能有一份 seatbelt 配置，两个不同配置的 `seatbelt()` 会 throw。决定和理由见 [DECISIONS.md](DECISIONS.md)；sandbox-runtime 的验证记录在 `docs/research/sandbox-evidence.md` §6.1。

## 依赖及理由

`@anthropic-ai/sandbox-runtime`（0.0.83）：`seatbelt()` 的操作系统门禁。自己写 Seatbelt 规则会踩符号链接路径的坑（evidence §3.1），它已经处理了；Apache-2.0。要求 Node ≥ 22.12、macOS 需要 `rg`（`brew install ripgrep`）。只在 `seatbelt()` 用到，`local()` / `docker()` 不碰它。

## 测试

```bash
cd hue
npx tsc -p packages/sandbox
node --import tsx --test packages/sandbox/test/sandbox.test.ts   # 54 个；npm test 也会跑
```

三个实现都过 core 的 `sandboxPortContract`，另有共同行为测试（路径逃逸、环境隔离、进程树被杀、输出上限、多字节）和各实现特有测试（docker：容器生命周期、非 root、网络、内存限制、额外挂载；seatbelt：写外被拒、denyRead、网络全断、符号链接）。没有 Docker 时 docker 部分 skip；非 macOS/Linux 时 seatbelt 部分 skip。默认用 `alpine:3` 做测试镜像（`HUE_TEST_IMAGE` 可改），顺便保证只依赖 busybox 就有的命令。

## 没验证的

- 只在 macOS + OrbStack 上跑过；Linux 原生 Docker、cgroup v1 没测；seatbelt 在 Linux（bubblewrap）完全没测。
- docker 默认联网：容器里的命令能把挂载目录里的内容发出去。
- docker：脱离进程组又清掉环境变量的进程（`setsid` 加 `env -i`）杀不到，只能靠容器被删。
- seatbelt：杀不了进程组，超时被杀的命令 fork 出的后台进程可能残留。
- seatbelt：目录内的相对符号链接（`inner-link -> ../sibling`）会报 `ENOENT` 而不是权限错误（evidence §6.1），真实 pnpm/`node_modules` 场景没验证。
- 检查路径和使用路径之间有时间差（TOCTOU）。
- 没有远程沙箱。
