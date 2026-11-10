# @hue/cli 决定记录

## 1. CLI 是配方，不是新的一层

- **选了**：`@hue/cli` 只装配已有包、解析参数、把事件打到终端。loop、工具、策略、落盘都不在这里实现。
- **否决的**：把 UI 写进 core 或 runtime；把 `examples/agent.ts` 直接改成产品入口（示例脚本还要给测试当装配样板，和可安装的 `hue` 命令分开更干净）。
- **代价**：装配代码和 `examples/agent.ts` 有重复。要改默认策略或系统提示时两处都要动。
- **何时要改**：装配稳定之后，再抽到 runtime 或一个共享模块，两边都调用。

## 2. 先 print 模式，再交互 TUI

- **选了**：第一版只保证 `hue -p` 能对着真实模型跑完一轮。交互界面以后再钉 `@earendil-works/pi-tui`，仍然只把 Hue 事件映射成显示，不引入整个 Pi。
- **否决的**：第一版就上 Ink 或 OpenTUI（和已经拍板的方向不一致；Ink 闪烁，OpenTUI 有 Zig/FFI 和运行时要求）。
- **代价**：现在没有多轮 REPL，也没有 `-c` 续聊开关（可以手动传 `--session`）。
- **何时要改**：print 模式在真实中转站上跑通之后。

## 3. 默认 docker，local 要显式选

- **选了**：默认和 `examples/agent.ts` 一样走 docker 副本，避免 CLI 直接改当前仓库。local 必须 `--sandbox local`；没有 TTY 时还要 `--yes` 才用 yolo。
- **代价**：第一次跑需要 Docker 和一个 git 仓库。只想试模型是否通时，用 `--sandbox local --yes` 在临时目录里跑。
