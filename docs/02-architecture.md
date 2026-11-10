# 02 架构

## 13 层 → 包
| 层 | 包 | 求职版 | 一句话 |
|---|---|---|---|
| provider | @hue/ai | ✅ 薄封装 | 统一模型调用与流式输出 |
| loop | @hue/core | ✅ | 模型 ↔ 工具循环，吐事件 |
| tools | @hue/tools | ✅ | 内置工具 + 手写 MCP client |
| eventlog | @hue/store | ✅ | 事件持久化、回放 |
| context | @hue/context | ✅ | token 预算与压缩 |
| skills | @hue/skills | ✅ | SKILL.md 渐进加载 |
| memory | @hue/memory | ✅ | 跨会话记忆 |
| policy | @hue/policy | 接口 | 工具审批与权限 |
| sandbox | @hue/sandbox | 接口 | 隔离执行 |
| subagents | @hue/runtime | ✅ | 子 agent / 排队 / 打断 / 恢复 |
| gateway | @hue/gateway | 骨架 | HTTP + SSE + 签名 webhook 接入(WebSocket 未做) |
| telemetry | @hue/telemetry | ✅ 最小 | 事件 → OTel GenAI span,OTLP/HTTP 导出（横切） |
| eval | @hue/eval | ✅ 最小 | 任务集 + 跑分（横切） |

## 依赖方向（硬规则）
```
            ┌──────────── runtime（唯一组装处）────────────┐
            │                                             │
  ai  tools  store  context  skills  memory  policy  sandbox
   \    |      |       |        |       |       |       /
    └───────────────────── core ──────────────────────┘
  telemetry / eval：只订阅事件，不被任何包依赖
```
- core 零 I/O、零运行时依赖：只定义类型、接口、loop（设计见 packages/core.md，代码 hue/packages/core）
- 包之间不互相 import，只依赖 core；组合只发生在 runtime 或用户的配方里
- DECIDE: tools 的 MCP client 要不要单独成 @hue/mcp（Pi 做法：零依赖独立包）TODO(verify)

## 事件合同（跨包唯一通信方式）
- 已定稿 v1，见 `packages/core.md` 第 4 节与代码 `hue/packages/core/src/event.ts`。
- 已决定：每个事件带 `v`；信封含 `id / sessionId / seq / at / turnId / step`；子 agent 通过 `session.created.parent` 构成事件树；delta 与 progress 不落盘；包的自定义事件用 `ext`。
- 本节原来的 DECIDE（版本策略、事件 ID 与因果关系、delta 是否持久化）已在 core.md D1/D2 与第 4 节关闭。

## 组装（配方长什么样）
```ts
// 草图：编码 agent 配方
const agent = createAgent({
  model: ai('anthropic:claude-…'),
  tools: [readFile(), editFile(), bash(), ...await mcp.connect('stdio', cmd)],
  context: compaction.summarize({ budget: 120_000 }),
  skills: skills.fromDir('./.hue/skills'),
  memory: memory.file('./.hue/memory'),
  store: store.sqlite('./.hue/log.db'),
})
for await (const e of agent.run('修复 #123')) render(e)
```
- DECIDE: 配方是函数调用（如上）还是声明式配置文件（hue.config.ts）？或两者
- DECIDE: 对外发布形态——13 个独立 npm 包，还是一个 `hue` 包 + 子路径导出（fx 做法），或两者都给

## Monorepo 骨架（建议）
```
hue/
  packages/{core,ai,tools,store,context,skills,memory,policy,sandbox,runtime,gateway,telemetry,eval}
  recipes/{coding-agent,resident-agent}
  evals/tasks/
  docs/  (就是这批文档)
```
- DECIDE: 工具链 pnpm + tsup / tsdown；测试 vitest；Node ≥ 22 还是 Bun 也支持
