# Hue

由 13 个小包组成的 Agent Harness（TypeScript，ESM，Node ≥ 20.3）。想法是：每个包一个下午能读完，也能单独替换。

它同时是一份求职作品集：目标是把 harness 的每一层亲手写一遍，并讲清每层的取舍。它不声称比 Pi 或 Claude Code 更好。只要一个编码 agent，请直接用它们。

## 现在做到哪（2026-11-06）

| | 状态 |
|---|---|
| `@hue/core`：类型、事件合同、六个端口、loop | 已写好（v0.2），28 个测试通过 |
| `@hue/ai`、`@hue/tools`、`@hue/store`、`@hue/runtime` 等其余包 | 未开始，任务书在 `docs/tasks/wave-1/` |
| 教学版 loop，两课 | 已写好，`hue/learn/` |
| **一个能跑的 agent** | **还没有** |

最后一行是现在最要紧的事实：core 单独不能用，因为没有真实模型、真实工具和持久化。`hue/packages/core/README.md` 的开头对此有说明。

## 接下来的顺序：先让它能跑，再吃透

**决定（2026-11-06）：** 优先打通一个能跑的 agent，再回头逐层吃透 core。

这取代了之前的打算，也就是先做教学课 3 到 5、再重写 core。原因有两个：

1. 不知道自己在为什么而写，是继续的最大阻力。一个能跑的东西会给每一层一个具体的用处。
2. 现在的 core 接口是否够用，只有被下游包真正使用时才能暴露。越早建下游，越早发现问题。

**初步顺序**，来自 `docs/tasks/wave-1/README.md` 的里程碑，可按进展裁剪：

1. `@hue/ai`：只接 Anthropic，流式，推理签名往返。第 2 课已经把核心难点写过一遍教学版。
2. `@hue/tools` 的内置工具：`read_file`、`edit_file`、`bash`。
3. `@hue/store`：先做一个最小的文件或 SQLite 事件日志，过 `eventStoreContract`。
4. **里程碑：一个约 30 行的脚本，用上面三个包加 core，在一个真实仓库里修好一个真实的 bug。**
5. 然后回头：对照这个能跑的版本读 core，补教学课，再决定哪些部分要亲手重写。

policy 和 sandbox 在任务书里也属于第一波。先不做它们，bash 工具的安全性会暂时靠人工看着，这一点要在里程碑的文档里写明。

## 目录

```
docs/     设计文档（中文）。入口 docs/README.md
notes/    定位、品牌、内容策略笔记
hue/      代码（npm workspaces）
  packages/core   内核
  learn/          教学版 agent loop，一课一目录
AGENTS.md 给 AI 助手和协作者的项目规则
```

## 先读什么

- 想理解设计：`docs/02-architecture.md`，然后 `docs/packages/core.md`
- 想看最有代表性的一个设计：`docs/application/portfolio-story.md`（写前日志与崩溃恢复）
- 想从零看懂 agent loop：`hue/learn/README.md`
- 想自己跑测试：见 `AGENTS.md` 的「命令」一节
