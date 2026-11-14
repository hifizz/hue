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

## 7. 对话区视觉按 mock 定型；预算再提到 1800

- **选了**：启动欢迎卡（`tui/welcome.ts`，状态五行 + 用法提示，橙色圆角边框，窄屏降单列）；对话区每个条目带 `●` 状态点（pending 金、成功绿、失败红、子 agent 青；用户消息用 `❯`）；工具结果收成一行 `└` 摘要（`4 matches`/`84 lines`/`exit 1 · …`），edit 渲染 old/new diff（红绿底，无行号：sandbox 里的文件读不到行号，也不改 tools 让它回传）；task 显示 `子 agent · N 步 · ↑x ↓y` 和 `├` 工具树（运行中来自 `tool.progress`，结束后/回放时从事件库里的子会话回填完整签名）；运行中在编辑器上方显示 pi-tui `Loader`（esc 中断）；footer 收成一行（`↑↓RW ctx%/窗口` 左、模型右）。为此预算再提到 1800（同第 6 条的理由：UI 仍全在配方包内）。
- **否决的**：给 edit 结果加行号（要么改 tools 的返回结构，要么 TUI 去摸 sandbox 的文件，都不值）；footer 保留两行 cwd/会话（挪进了欢迎卡）；`/compact`、`/tree`、`/fork`、`/settings` 等还没后端的命令仍不做假实现。
- **代价**：edit diff 没有行号；子 agent 树是结束后才补全签名。
- **何时要改**：tools 若返回结构化 diff/行号，或 sandbox 提供按路径读文件的通道，再把行号补上。

## 8. recipe 挂只读 `task` 子 agent

- **选了**：`openRecipe` 里用 `createAgent` 再建一个子 agent（模型与父共享 `relay`，只给 read/list/glob/grep，独立 instructions），经 `subagentTool({ effects: 'none' })` 挂进主 agent 的工具表。和父 agent 共用 store/policy/sandbox；子会话事件落同一日志，靠 `session.created.parent` 连回那次调用。
- **为什么**：mock 里 `task(...)` 是并行调研入口；只读工具集才配得上 `effects: 'none'`（同一步可并发派发），写工具和 bash 不进子 agent。
- **代价**：子 agent 不能跑 `npm test` 之类，调研里需要命令时得回到父 agent 自己跑。
- **何时要改**：如果需要"能改代码的子 agent"，加一个带写工具的变体（effects 换 'unsafe'，policy 会逐个问）。

## 9. `@` 补全的 fd 依赖与 Node 兜底

- **问题**：pi-tui 的 `@` 模糊补全只走 `fd`（`CombinedAutocompleteProvider` 第三个构造参数 `fdPath`，为 null 时 `getFuzzyFileSuggestions` 直接返回 `[]`），构造时从没传过，`@` 等于死代码。
- **选了**：启动时扫 PATH 找 `fd` / `fdfind` 传给基类；找不到时 `getSuggestions` 先让 super 跑（斜杠命令和普通路径补全不依赖 fd），只有 `@` token 那条分支用 Node 递归扫 cwd 兜底（跳 `.git`/`node_modules`，深度 ≤6、扫描 ≤2 万条，打分/排序对齐 pi-tui）。
- **代价**：兜底不尊重 .gitignore，结果集和 fd 略有差异；token 切分只按空白，不处理 CJK 标点边界。
- **何时要改**：pi-tui 若内置非 fd 后端或导出 scoped query 逻辑，删掉兜底。

## 10. VStack 溢出时 editor/footer 被裁到 0 行

- **问题**：对话超高时 VStack 按比例收缩，没设 `minSize` 的 footer 被压到 0 行消失，editor 下边框也被裁。
- **选了**：editor `minSize: 3`（上下边框 + 一行输入）、footer `minSize: 1`，收缩全部由 ScrollView 吸收。
