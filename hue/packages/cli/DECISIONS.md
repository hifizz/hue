# @hue/cli 决定记录

## 1. CLI 是配方，不是新的一层

- **选了**：`@hue/cli` 只装配已有包、解析参数、把事件打到终端。loop、工具、策略、落盘都不在这里实现。
- **否决的**：把 UI 写进 core 或 runtime；把 `examples/agent.ts` 直接改成产品入口（示例脚本还要给测试当装配样板，和可安装的 `hue` 命令分开更干净）。
- **代价**：装配代码和 `examples/agent.ts` 有重复。要改默认策略或系统提示时两处都要动。
- **何时要改**：装配稳定之后，再抽到 runtime 或一个共享模块，两边都调用。

## 2. 交互 TUI 只钉 pi-tui，视觉对齐 Pi，不复制源码

- **选了**：print 模式之后，交互界面只依赖 `@earendil-works/pi-tui`（钉 1.5.2）。对话、编辑器、状态栏三段式布局，斜杠命令的名称和用法对齐 Pi，只实现 Hue 已经有后端的那些。
- **否决的**：Ink、OpenTUI；把 Pi 的组件或主题源码抄进来；为还没有后端的命令做假实现（`/compact`、`/tree`、`/fork`、`/clone`、`/mcp`、`/share`、`/bug`、`/llama` 等）。
- **代价**：`/compact` 要等手动压缩入口出现再接。没有模型目录时，`/model` 只能靠参数切换，打不开选择器。导出只做 Markdown / JSONL，不做 HTML。
- **何时要改**：对应能力进了现有包之后，再往同一张命令表里加。

## 3. 默认 docker，local 要显式选

- **选了**：默认和 `examples/agent.ts` 一样走 docker 副本，避免 CLI 直接改当前仓库。local 必须 `--sandbox local`；没有 TTY 的 print 模式还要 `--yes` 才用 yolo。交互模式下 local 走 `coding()`，危险命令在 TUI 里询问。
- **代价**：第一次跑需要 Docker 和一个 git 仓库。日常交互更常会加 `--sandbox local`。只想试模型是否通时，用 `--sandbox local --yes` 在临时目录里跑。

## 4. tsx 从安装位置解析

- **选了**：`bin/hue.mjs` 用 `import.meta.resolve('tsx')` 得到绝对路径，再传给 `node --import`。
- **为什么**：`--import tsx` 按当前工作目录解析。把 `hue` 放进 PATH 后在别的仓库里跑，就会 `Cannot find package 'tsx'`。
- **代价**：仍然依赖工作区根上的 `tsx`，还没有把 CLI 编成纯 JS。

## 5. `!` / `!!` 走现有 bash 工具

- **选了**：行首 `!` / `!!` 都经过 `@hue/tools` 的 `bash`、当前 policy 和 sandbox，不另开一条本地 shell。`!` 的输出会拼进下一次发给模型的提示词；`!!` 只显示在对话记录里。
- **否决的**：直接 `child_process` 跑命令（会绕过审批和沙箱）。
- **代价**：没有单独的 shell 事件类型，`!` 的输出要等下次发送才会进事件日志。

## 6. 行数预算提高到 1400

- **选了**：TUI 布局、命令和事件渲染放进 `@hue/cli` 之后，把 `cli` 的预算从 400 提到 1400。
- **为什么**：交互界面的代码量比 print 模式大，但仍全部留在配方包里，不改 core。
