# @hue/cli

把已经有的包装配成 `hue` 命令。这是配方，不是第 14 层 harness：不改 core，UI 只渲染事件。

当前只做了 print 模式（`hue -p`）。交互 TUI（打算只钉 `@earendil-works/pi-tui`）还没做。

```bash
cd hue
./packages/cli/bin/hue.mjs -p --sandbox local --yes "<任务>"
# 或
npx tsx packages/cli/src/cli.ts -p --cwd <仓库> "修这个测试"
```

- 模型、key、地址读 `HUE_MODEL`、`AI_GATEWAY_*`（或 `ANTHROPIC_*`）。会从 `--cwd` 和本仓库的 `hue/` 目录加载 `.env.local` / `.env`，不覆盖已经在环境里的键。
- `-p` / `--print`：跑完一轮就退出。`--json` 每条事件一行 JSON。
- `--sandbox docker`（默认）：在仓库的 git 副本上、容器里跑，策略 `yolo`。`--sandbox local` 在目录本身上跑，策略 `coding()`（会问 y/N）；配 `--yes` 才用 `yolo`。
- `--model`、`--session`、`--db`、`--cwd` 见 `hue -h`。
- `HUE_TRACE`、`HUE_OTLP`、`HUE_SKILLS`、`HUE_MEMORY`、`HUE_COPY` 和 `examples/agent.ts` 一样。

## 依赖及理由

没有新的运行时依赖。装配用现有包；启动器用 Node 内置 `child_process` 调 `tsx`（工作区已经有）。

## 测试

```bash
cd hue
npx tsc -p packages/cli
node --import tsx --test packages/cli/test/*.test.ts
```
