# @hue/cli

把已经有的包装配成 `hue` 命令。这是配方，不是第 14 层 harness：不改 core，UI 只渲染事件。

```bash
cd hue
# 交互 TUI（需要 TTY）
./packages/cli/bin/hue.mjs --sandbox local --yes
# 打开后立刻发送一条提示词
./packages/cli/bin/hue.mjs --sandbox local --yes "看看这个仓库"
# 接着这个目录最近一次会话
./packages/cli/bin/hue.mjs -c --sandbox local --yes
# print 模式：跑完一轮就退出
./packages/cli/bin/hue.mjs -p --sandbox local --yes "<任务>"
```

- 模型、key、地址读 `HUE_MODEL`、`AI_GATEWAY_*`（或 `ANTHROPIC_*`）。会从 `--cwd` 和本仓库的 `hue/` 目录加载 `.env.local` / `.env`，不覆盖已经在环境里的键。
- 不加 `-p` 进入交互 TUI（默认 fullscreen，和 Pi 一样用备用屏；`--tui-mode regular` 用终端滚动缓冲）。
- `-p` / `--print`：跑完一轮就退出。`--json` 每条事件一行 JSON。
- `-c` / `--continue`：接着这个目录最近一次会话（写在 `.hue/last-session`）。
- `--sandbox docker`（默认）：在仓库的 git 副本上、容器里跑，策略 `yolo`。`--sandbox local` 在目录本身上跑，策略 `coding()`（会问）；配 `--yes` 才用 `yolo`。
- `--model`、`--session`、`--db`、`--cwd` 见 `hue -h`。
- `HUE_TRACE`、`HUE_OTLP`、`HUE_SKILLS`、`HUE_MEMORY`、`HUE_COPY` 和 `examples/agent.ts` 一样。

## 交互界面

对话记录在中间，下面是多行编辑器，再往下是状态栏（目录、会话、模型、上下文用量）。快捷键见 TUI 里的 `/hotkeys`。

第一批斜杠命令：`/quit`、`/new`、`/resume`、`/session`、`/model`、`/copy`、`/name`、`/export`、`/hotkeys`，输入 `/` 即可搜索。`!command` / `!!command` 走现有的 bash 工具和 policy/sandbox，不另开本地 shell。

`/compact`、`/tree`、`/fork`、`/clone`、`/mcp` 以及 Pi 自己的登录和分享命令还没有对应后端，这一版不做。

## 依赖及理由

交互界面只钉 `@earendil-works/pi-tui`（1.5.2；需要 Node ≥ 22.19）。装配仍用现有包；启动器用 Node 内置 `child_process` 调 `tsx`（工作区已经有）。

## 测试

```bash
cd hue
npx tsc -p packages/cli
node --import tsx --test packages/cli/test/*.test.ts
```
