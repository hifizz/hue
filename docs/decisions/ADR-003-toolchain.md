# ADR-003 工具链：npm workspaces + tsx + node:test + 逐包 tsc
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认；`npm run check` 的实现是同日新做的）
- 包：全仓
- 来源标记：`DECIDE: 工具链 pnpm + tsup / tsdown；测试 vitest；Node ≥ 22 还是 Bun 也支持`（docs/02-architecture.md:62）

## 问题
用什么包管理、构建、测试、类型检查？支持哪些运行时？

## 候选
1. pnpm + tsup / tsdown + vitest，Node ≥ 22，可选 Bun。
2. npm workspaces，不构建（直接跑 TypeScript 源码），Node 内置测试，`tsc` 只做检查。

## 各家怎么做（附出处）
没有核实过。

## 决定
选 2。
- 包管理：npm workspaces（`hue/package.json` 的 `workspaces: ["packages/*"]`）。
- 没有构建步骤：每个包 `exports` 指向 `src/index.ts`，用 `tsx` 运行（`node --import tsx`）。
- 测试：`node:test` + `node:assert/strict`，`npm test`。
- 类型检查：`tsconfig.base.json`（`strict`、`NodeNext`、`noEmit`、`verbatimModuleSyntax`），每个包一份 tsconfig。`npm run check` 即 `scripts/check.mjs`，对 14 个包、`examples/`、`learn/` 各跑一次 `tsc -p`，并行，任何一个失败就退出 1。
- 运行时：Node ≥ 20.3（core 用 `AbortSignal.any`）；`@hue/store` 的 sqlite 用 `node:sqlite`，要 Node ≥ 22.5（store DECISIONS 第 4 条）；没有验证过 Bun。
- 第三方依赖：每加一个都在包 README 写理由，能用 Node 内置就不用库（AGENTS.md）。

**没有比较过 pnpm / tsup / vitest（你确认）。** 这套工具链是照任务书的规则来的，不是比较之后的选择：`docs/tasks/wave-1/00-shared-rules.md` 规定测试用 `node:test` + `node:assert/strict`、用 `tsx` 跑，"能用 Node 内置就不用库"，依赖只允许 `@hue/core`。所以这份 ADR 记录的是**现状和它的代价**，不是对三套候选的论证；`02-architecture.md:62` 的 DECIDE 应理解为"没有评估，按默认走"。
如果将来要发布到 npm（见"代价"），这时才需要真正比较构建工具（tsup / tsdown）。

## 为什么 `check` 不用 `tsc -b`
`tsc -b` 要靠项目引用，要求各包 `composite` 并产生声明输出；这些包是 `noEmit`，改成 composite 是另一套配置，对这里没有收益。原来 `npm run check` 指向 `tsc -b`，而根目录没有 `tsconfig.json`，所以一直不能用（AGENTS.md 和 `docs/research/harness-comparison.md:241` 都提过这个漂移）。

## 代价
没有构建产物，包不能直接发布到 npm（现在所有包都是 `private: true`、版本 `0.0.0`）。`tsx` 是运行时依赖。`check` 并行起 16 个 `tsc` 进程，机器小的时候会慢。

## 如何验证（eval / 测试）
- `npm run check` 16 个项目全部 ok；往 `packages/policy/src` 里注入一个类型错误后它报 FAIL（`policy`、`cli`、`examples` 三个都失败，因为后两者引用了 policy），还原后恢复。
- CI 与 lint 见 [ADR-022](ADR-022-lint-via-strict-tsc-and-ci.md)。`tsconfig.base.json` 现在还打开了 6 个严格选项。
