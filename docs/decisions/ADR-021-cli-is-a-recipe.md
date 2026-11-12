# ADR-021 CLI 是配方，不是新的一层
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/cli
- 来源标记：`DECIDE: 配方是函数调用（如上）还是声明式配置文件（hue.config.ts）？或两者`（docs/02-architecture.md:51）；`DECIDE: 对外发布形态`（02-architecture.md:52）——后者**未决**

## 问题
可安装的 `hue` 命令放在哪一层？配方用函数调用还是声明式配置？

## 候选
1. 把 UI 写进 core 或 runtime。
2. 把 `examples/agent.ts` 直接改成产品入口。
3. 单独的 `@hue/cli`，只装配已有包、解析参数、把事件打到终端。

## 各家怎么做（附出处）
交互界面的斜杠命令名称和用法对齐 Pi，但没有对照过 Pi 的源码，也没有抄它的组件或主题。

## 决定
选 3，配方是函数调用（`createAgent({...})`），不做 `hue.config.ts`。
- loop、工具、策略、落盘都不在 cli 里实现。
- 默认走 docker 副本，避免直接改当前仓库；local 要显式 `--sandbox local`；没有 TTY 的 print 模式还要 `--yes` 才用 yolo。
- 交互 TUI 只依赖 `@earendil-works/pi-tui`（钉 1.5.2），不复制 Pi 源码；只实现 Hue 已有后端的斜杠命令。
- `!` / `!!` 经过 bash 工具、policy 和 sandbox，不另开本地 shell。
- `bin/hue.mjs` 用 `import.meta.resolve('tsx')` 得到绝对路径，因为 `--import tsx` 按当前工作目录解析，在别的仓库里会找不到 tsx。
- 行数预算提高到 1400（见 ADR-004 的例外说明）。

## 代价
装配代码与 `examples/agent.ts` 有重复，改默认策略或系统提示要动两处。第一次跑需要 Docker 和一个 git 仓库。没有模型目录时 `/model` 打不开选择器。仍依赖工作区根上的 `tsx`，没有编成纯 JS。

## 何时要改
装配稳定之后，把重复部分抽到 runtime 或共享模块。

## 如何验证（eval / 测试）
cli 的测试；`!` 的输出要等下次发送才进事件日志（没有单独的 shell 事件）。**对外发布形态没有决定**：现在所有包都是 `private` 且无构建（ADR-003）。
