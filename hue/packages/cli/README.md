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
- `-m` / `--model`、`--session`、`--db`、`--cwd` 见 `hue -h`。
- 颜色：`--no-color` 或环境变量 `NO_COLOR` 关闭。工具前的圆点：金色进行中、绿色成功、橙色失败、蓝色是子 agent；agent 在跑时输入框边框变橙色，状态栏出现「运行中」。
- `HUE_TRACE`、`HUE_OTLP`、`HUE_SKILLS`、`HUE_MEMORY`、`HUE_COPY` 和 `examples/agent.ts` 一样。
- `HUE_THINKING=off`：不发 thinking 参数（排查长推理让流超时，或模型不支持 thinking）。默认开 adaptive。
- `HUE_CONTEXT_BUDGET=<token 数>`：覆盖压缩的触发线（默认是模型窗口的 80%）。校准阈值时调小它，否则 1M 窗口里几乎触发不了压缩。
- `HUE_PNPM_CACHE=1`：docker 模式给 pnpm store 挂一个跨容器缓存（默认 `~/.cache/hue/pnpm-store`，给值就换目录）。不开每次任务都从零下依赖（M1 实测一次 `pnpm install` 4 分 5 秒，占那次工具时间的 85%）。开启后系统提示会多一句话，让 agent 用 `--store-dir /pnpm-store` 装。

## 交互界面

开头是一个橙色圆角横幅（左上角是方块字符拼的像素风色环，所有终端一样，见 DECISIONS 10）（模型、沙箱、策略、上下文、会话，宽终端右边还有提示），然后是对话记录、多行编辑器和一行状态栏（用量、上下文占比、会话名和模型）。工具调用画成 `● name(参数)` 加 `⎿` 结果行，`edit` 会在下面画红 / 绿底的改动。配色取自 Pi 的 dark 主题，见 DECISIONS 7。快捷键见 TUI 里的 `/hotkeys`。

斜杠命令：`/help`、`/new`、`/resume`、`/model`、`/session`、`/name`、`/copy`、`/export`、`/hotkeys`、`/quit`，输入 `/` 即可搜索；`/exit`、`/clear` 是 `/quit`、`/new` 的别名。敲错命令名会给候选。`!command` / `!!command` 走现有的 bash 工具和 policy/sandbox，不另开本地 shell。

`/compact`、`/tree`、`/fork`、`/clone`、`/mcp` 以及 Pi 自己的登录和分享命令还没有对应后端，这一版不做。

## 依赖及理由

交互界面只钉 `@earendil-works/pi-tui`（1.5.2；需要 Node ≥ 22.19）。装配仍用现有包；启动器用 Node 内置 `child_process` 调 `tsx`（工作区已经有）。

## 测试

```bash
cd hue
npx tsc -p packages/cli
node --import tsx --test packages/cli/test/*.test.ts
```
