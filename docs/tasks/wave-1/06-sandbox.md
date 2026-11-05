# 任务：@hue/sandbox —— 执行环境

**预算** 600 行 · **依赖** core · **合同** `sandboxPortContract`

## 目标
实现 core 的 `SandboxPort`，内置工具的所有 I/O 都经过它。先做两个实现：本地进程（默认，开发用）和 Docker（隔离）。

## 对外 API
```ts
import { local, docker } from '@hue/sandbox'
const sb = local({ root: '/path/to/repo', allowOutsideRoot: false })
const sb2 = await docker({ image: 'node:22', mount: '/path/to/repo', network: 'none' })
await sb2.dispose()
```

## 必须做到
1. 两个实现都过 `sandboxPortContract`（Docker 的在没有 docker 时 skip）。
2. **超时**：到时杀掉整个进程组（不只是 shell），`timedOut: true`。
3. **abort**：signal 触发时杀进程并以 `AbortError` reject。
4. **路径**：`local` 把所有路径解析到 root 内，越界（含符号链接逃逸）抛 `HueFault`；`docker` 只挂载 mount 目录。
5. **输出上限**：stdout / stderr 各自超过上限（默认 1MB）时停止收集并标记，避免内存爆掉（截断给模型看的长度是工具的事，这里只防爆）。
6. `env` 默认**不继承**宿主环境变量（防止 API key 泄给模型执行的命令），只给最小集合（PATH、HOME、LANG）+ 调用方传入的。
7. Docker：容器在第一次使用时启动、多次 exec 复用、`dispose()` 删除；默认 `--network none`、非 root 用户、限制内存和 CPU。

## 你来决定
- local 的 env 白名单具体内容。
- Docker 用 CLI（`docker exec`）还是 Engine API（unix socket HTTP）。建议 CLI：零依赖、够用。
- 是否预留远程沙箱（E2B / Fly Sprites）的实现位置：只在 DECISIONS 写接入草图，不实现。

## 额外测试
- 符号链接逃逸、`../` 逃逸。
- 进程组：`bash -c 'sleep 100 & sleep 100'` 超时后两个都被杀。
- 宿主 env 里的 `ANTHROPIC_API_KEY` 在 exec 里看不到。

## 不做
权限判断（policy）、工具逻辑（tools）。
