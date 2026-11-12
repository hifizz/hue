# AGENTS.md

Hue：由 13 个小包组成的 Agent Harness（TypeScript，ESM，Node ≥ 20.3）。同时是求职作品集，所以"可读、可换、讲得清取舍"比功能多更重要。

## 仓库布局（单仓）
```
docs/    设计文档（中文）。入口 docs/README.md
notes/   定位、品牌、内容策略笔记
hue/     代码（npm workspaces，packages/*）。目前有 packages/core、packages/ai（仅 Anthropic）、packages/tools（内置工具 + MCP client）、packages/store（memory + sqlite）、packages/sandbox（local + docker）、packages/policy（rules + 预设）、packages/context（truncate / fold / summarize / chain）、packages/runtime（createAgent、子 agent）、packages/eval（任务、执行器、判分、报告）、packages/skills（SKILL.md 渐进加载）、packages/memory（markdown 笔记）、packages/gateway（HTTP + SSE 接入、签名 webhook）、packages/telemetry（事件 → OTel span）
hue/learn/  教学版 agent loop，一课一目录，自包含，不依赖 @hue/core。入口 hue/learn/README.md
```
文档和代码在同一个 git 仓库里，改接口时一次提交同时改两边。

## 先读什么
1. `docs/README.md`：目标、标记约定、目录
2. `docs/02-architecture.md`：13 层到包的映射、依赖方向
3. `docs/packages/<包>.md`：你要动的那个包的设计页
4. 做新包时再加读 `docs/tasks/wave-1/00-shared-rules.md`（硬性边界、包结构、完成标准）

## 命令（在 `hue/` 下执行）
```bash
npm install
npm test                      # node:test + tsx，全仓测试
npx tsc -p packages/<包>      # 单包严格类型检查
npm run budget                # 每包 src/ 行数预算
npx tsc -p learn              # learn/ 类型检查
node --import tsx --test learn/*/*.test.ts   # learn/ 的测试（npm test 不包含它们）
```
`npm run check`（`scripts/check.mjs`）对每个包、`examples/`、`learn/` 各跑一次 `tsc -p`，任何一个有错就失败。没有用 `tsc -b`：各包是 noEmit、没开 composite。只检查一个包用 `npx tsc -p packages/<包>`。`tsconfig.base.json` 还打开了未使用变量 / 参数、隐式返回、`override`、`noUncheckedIndexedAccess` 等严格选项，它们就是本仓库的 lint（不用 ESLint，见 ADR-022）。CI 在 `.github/workflows/ci.yml`：`check`、`budget`、`test`。

## 架构硬规则
- 事件日志是唯一事实源，消息历史是 `fold(events)` 的投影。
- `@hue/core` 零 I/O、零运行时依赖。包之间不互相 import，只依赖 core。组合只发生在 runtime 或配方里。
- 包通过 core 的 6 个端口接入（ModelPort、ContextStrategy、PolicyPort、InputPort、SandboxPort、EventStore）。skills、memory、MCP、子 agent 都是 `Capability`。
- 包要加事件，用 `ext`，不改核心事件联合类型。
- 进日志的东西必须能 `JSON.stringify`。错误用 core 的 `HueError` / `HueFault`，错误码取封闭集合。
- 阻塞操作都要接收并尊重 `AbortSignal`。

## 改动规则
- **`@hue/core` 已冻结（v0.2）**。改 core 接口的顺序：先改 `docs/packages/core.md`，再改代码和合同测试，破坏性变更升 `specVersion`。core 现有的 loop 测试和合同测试必须一直通过。
- 做某个包时只改 `hue/packages/<该包>/`。发现 core 不够用，在该包目录写 `CHANGE-REQUEST.md`，不要绕过。
- 每包有行数预算（`hue/scripts/budget.mjs`），超了就删代码，不要调预算。
- 第三方依赖每加一个都在包 README 写一行理由，能用 Node 内置就不用库。

## 包的结构
```
packages/<包>/
  package.json     name: @hue/<包>, type: module, exports 指向 src/index.ts
  tsconfig.json    extends ../../tsconfig.base.json, types: ["node"]
  README.md        一屏：是什么、10 行以内示例、依赖及理由
  src/index.ts     唯一公共入口
  test/*.test.ts   node:test + node:assert/strict
  DECISIONS.md     问题 / 选项 / 选了什么 / 为什么 / 代价 / 何时要改
```

## 代码风格
- 小文件、小函数、少抽象。工厂函数加对象字面量，不写 class 继承。
- 注释写"为什么"，不写"做了什么"。一个文件内中英文统一。
- 对其他 harness（Pi、AI SDK、Mastra、fx、Claude Code）的说法没核实过的，标 `TODO(verify)`，不要当事实写。

## 文档标记
| 标记 | 含义 |
|---|---|
| `DECIDE:` | 待拍板，已列候选。拍板后写 ADR（`docs/decisions/ADR-000-template.md`）并改文档。已有的 ADR 和每个标记的去向见 `docs/decisions/README.md` |
| `TODO(deep):` | 需要单独深挖 |
| `TODO(verify):` | 需对照源码核实 |
| `LATER:` | 求职版不做 |

查全部待办：`grep -rn "DECIDE:\|TODO(deep)\|TODO(verify)" docs/`。处理完把标记删掉或改成 `DONE(ADR-xxx)`。

## 品牌与对外说法
- 色轮只用 橙、金、绿、青、天蓝。**不要用粉色或紫色。**
- 对外写 Hue Agent / hue.dev，避开 Philips Hue。
- 不说"比 Pi / Claude Code 更好"，说"把 harness 13 层亲手写一遍，每层讲取舍"。

## 当前状态
core 完成（loop 测试、合同自测、崩溃扫描共 28 个，约 900 行）。第 1 波 6 个包里 `ai` 已实现（仅 Anthropic，OpenAI 未做；真实 API 合同待在线跑），`tools` 内置工具已实现（未接真实模型和 sandbox），`store` 已实现（memory + sqlite，kill -9 测试通过），`sandbox` 已实现（local + docker，仅 macOS + OrbStack 验证），`policy` 已实现（规则 + 三个预设 + withGrants，白名单未经真实任务调过），`context` 已实现（三种压缩策略 + chain，摘要质量未测；切点已放宽到工具结果之后，长任务内也能 truncate / summarize），`runtime` 已实现（createAgent：落盘、崩溃恢复、steer / interrupt、子 agent 作为工具；`examples/agent.ts` 已改用它；排队式 steer 与真实模型下的子 agent 未验证），`eval` 最小版已实现（5 道内置编码题 + runner + 报告；`examples/eval.ts` 接了 agent；没有用真实模型跑过，没有对照组），`skills` 已实现（索引 + load_skill 工具，兼容 Anthropic 目录布局；没用真实模型验证），`memory` 已实现（markdown 文件 + remember / recall / forget；召回质量未测，没用真实模型验证），`tools` 的 MCP client 已实现（stdio + Streamable HTTP，2026-07-28 加 2025-11-25 回退；stdio 上连过真实的 filesystem server 两个版本：2.2.0 走新协议、2025.8.21 走回退，两者都调用成功；其余只对着自带的 mock server 测过，没连过真实的 HTTP server，没和官方 SDK 对过报文）。`gateway` 骨架已实现（HTTP + SSE + 人工批准 + 签名 webhook，接入文档见该包 INTEGRATION.md；没有设计页和任务书，接口是实现时定的；无 WebSocket、无具体 IM 平台适配、没有用真实模型/浏览器/IM/反向代理验证，`examples/gateway.ts` 没真正启动过）。`telemetry` 已实现（事件 → OTel GenAI span，OTLP/HTTP JSON 导出，observeStore 包住 store；没对着真实 collector 发过，GenAI 约定本身仍是 Development 状态）。路线见 `docs/03-roadmap.md`。

**当前优先级（2026-11-06 决定）：先让一个 agent 能跑，再回头吃透 core。** 顺序见根目录 `README.md`。在 runtime 和一个能跑的脚本出现之前，core 单独不能用，写文档和示例时不要把它说成可直接使用的框架。
