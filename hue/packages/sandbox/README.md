# @hue/sandbox

core 的 `SandboxPort` 的两个实现：本地进程 `local()` 和 Docker 容器 `docker()`。内置工具的所有 I/O 都经过它。零运行时依赖。

```ts
import { local, docker } from '@hue/sandbox'

const a = await local({ root: '/path/to/repo' })                  // 路径锁 + 环境变量白名单；命令不隔离
const b = await docker({ mount: '/path/to/repo', image: 'node:22' }) // 容器里跑命令，只看得到 mount
await b.exec('npm test', { timeoutMs: 60_000 })
await b.dispose()                                                  // 删除容器
```

| | `local` | `docker` |
|---|---|---|
| 文件接口（read/write/list） | 路径必须在 root 内，含符号链接 | 同左，经挂载目录，容器里是 `/work` |
| `exec` | 以你的用户身份，**能 `cd /` 出去** | 在容器里，只看得到挂载目录，非 root |
| 环境变量 | 不继承宿主，最小集合 + 传入的 | 同左 |
| 超时 / 取消 | 杀整个进程组 | 杀容器里带标记的所有进程 |
| 输出 | 每个流最多 1 MB，超出标注 | 同左 |
| 网络 | 宿主的 | 默认联网（`bridge`），`network: 'none'` 断网 |

容器第一次 `exec` 才启动，崩溃时靠 TTL（默认 4 小时）自己退出。决定和理由见 [DECISIONS.md](DECISIONS.md)。

## 测试

```bash
cd hue
npx tsc -p packages/sandbox
node --import tsx --test packages/sandbox/test/sandbox.test.ts   # 34 个；npm test 也会跑
```

两个实现都过 core 的 `sandboxPortContract`，另有共同行为测试（路径逃逸、环境隔离、进程树被杀、输出上限、多字节）和 docker 特有测试（容器生命周期、非 root、网络、内存限制）。没有 Docker 时 docker 部分 skip。默认用 `alpine:3` 做测试镜像（`HUE_TEST_IMAGE` 可改），顺便保证只依赖 busybox 就有的命令。

## 没验证的

- 只在 macOS + OrbStack 上跑过；Linux 原生 Docker、cgroup v1 没测。
- 默认联网：容器里的命令能把挂载目录里的内容发出去。
- 脱离进程组又清掉环境变量的进程（`setsid` 加 `env -i`）杀不到，只能靠容器被删。
- 检查路径和使用路径之间有时间差（TOCTOU）。
- 没有远程沙箱。
