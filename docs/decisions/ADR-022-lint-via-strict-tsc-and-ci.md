# ADR-022 lint 用 tsc 的严格选项；类型检查逐包 `tsc -p`；CI 跑 check / budget / test
- 状态：已接受（2026-11-12，来自 `docs/05-next-plan.md` M0；CI 的实际运行结果未验证）
- 包：全仓
- 来源标记：无 `DECIDE:`。出处 05-next-plan.md M0："根目录补 tsconfig.json（references）""CI""lint：ESLint 或 tsc --noEmit 之外的最小规则；如果觉得不值，写 ADR 说明不做"

## 问题
M0 要三样东西：全仓类型检查入口、CI、lint。计划里写的做法是根目录 `tsconfig.json` 加 `references`，lint 用 ESLint 或最小规则。

## 候选
1. 类型检查：A 根目录 `tsconfig.json` + `references`，用 `tsc -b`；B 逐包 `tsc -p`，由一个脚本汇总。
2. lint：A 引入 ESLint / Biome；B 不做；C 打开 tsc 的严格选项（未使用的变量和参数、隐式返回、`override`、switch 贯穿、索引访问可能为 `undefined`）。
3. CI：GitHub Actions 跑 `check`、`budget`、`test`。

## 各家怎么做（附出处）
没有核实过。

## 决定
- **类型检查选 B**：`scripts/check.mjs` 对 14 个包、`examples/`、`learn/` 各跑一次 `tsc -p` 并行汇总。理由与 [ADR-003](ADR-003-toolchain.md) 相同：包是 `noEmit`、没开 `composite`，`references` 要的是另一套配置，对这里没有收益。**这偏离了 05-next-plan.md 的写法**，由你在对话里确认了"按 ADR-003"。
- **lint 选 C**：在 `tsconfig.base.json` 打开 `noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`noUncheckedIndexedAccess`。开之前全仓只有 18 个错误，已全部修掉（多为未使用的 import 和变量，没有改变行为）。不引入 ESLint / Biome：零依赖原则（AGENTS.md），而且这套规则已经抓住了此前没人发现的死代码。
- **CI 选 3**：`.github/workflows/ci.yml`，在 `ubuntu-latest` + Node 22 上顺序跑 `npm ci`、`npm run check`、`npm run budget`、`npm test`。Node 22 是 `node:sqlite` 的下限（≥ 22.5，见 store DECISIONS 第 4 条）；本地开发用 24，所以 CI 实际是在测下限版本。

## 代价
- 没有 ESLint 的那类规则：不能强制命名、`no-floating-promises`、`no-explicit-any` 等。测试里大量用 `as any`，现在不拦。
- `noUncheckedIndexedAccess` 让数组下标访问要处理 `undefined`，测试里要多写 `?.` 或 `!`。
- CI 在 Linux 上跑，`docker` 用例会真跑（runner 自带 Docker）；这些用例此前只在 macOS + OrbStack 上跑过，**第一次在 Linux 上跑可能失败**（正好是 05-next-plan.md M5 P0 "sandbox: Linux 验证"要找的问题）。
- `npm test` 不含 `examples/*.test.ts` 和 `learn/`（与本地一致），所以这些测试 CI 也不跑。

## 何时要改
- 出现需要 ESLint 才能挡住的真实问题（例如漏掉的 `await`）时，再加 ESLint，并为它写 ADR。
- CI 在 Linux 上稳定失败的用例，要么修，要么在 CI 里明确 skip 并记下原因，不要悄悄关。

## 如何验证（eval / 测试）
- `npm run check`：16 个项目全部通过；`npm test`：511 个，507 通过、0 失败、4 个跳过；`npm run budget` 无超限。
- 往 `packages/policy/src` 注入一个类型错误，`check` 报 FAIL（此前验证过）。
- **CI workflow 没有在 GitHub 上跑过**：本机只检查了 YAML 能解析、`npm ci --dry-run` 通过。第一次推送后要看 Actions 的结果。
