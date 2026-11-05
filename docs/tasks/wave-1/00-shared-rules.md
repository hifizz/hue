# 第 1 波共享规则（每个任务都要贴这一份）

## 你是谁、在做什么
你在给 Hue 实现一个包。Hue 是一个由 13 个小包组成的 Agent Harness（TypeScript，ESM，Node ≥ 20.3）。
核心包 `@hue/core` 已经完成并冻结：类型、事件合同、端口接口、loop、合同测试。你实现的包插在 core 定义的某个端口上。

## 你会拿到的上下文
1. `docs/02-architecture.md`（整体结构）
2. `docs/packages/core.md`（core 设计，**必读第 3、4、5、7 节**）
3. `hue/packages/core/src/` 全部源码（尤其 `ports.ts`、`tool.ts`、`model.ts`、`event.ts`）
4. `hue/packages/core/contracts/` 里与你相关的合同测试
5. 你这个包的设计页 `docs/packages/<包>.md`（如果有）
6. 你的任务说明（本目录下对应文件）

## 硬性边界
- **只改 `hue/packages/<你的包>/` 目录**。不得修改 core、不得修改别的包、不得改根目录配置。
- 发现 core 接口不够用或合同测试有错：**停下来**，写一份 `CHANGE-REQUEST.md` 放在你的包目录里（要改什么、为什么、对其他包的影响、有没有不改接口的替代办法），然后继续做不受影响的部分。不要自己绕过。
- 只依赖 `@hue/core`（workspace 依赖）。第三方依赖每加一个都要在 README 里写一行理由；能用 Node 内置就不用库。
- 不得依赖其他 `@hue/*` 包（telemetry 也不行）。
- `src/` 代码行数不超过预算（见各任务；`node scripts/budget.mjs` 检查）。
- 所有可能阻塞的操作都接收并尊重 `AbortSignal`。
- 进日志的东西（错误、输出、元数据）都必须是可 `JSON.stringify` 的 `Json`；错误用 core 的 `HueError` / `HueFault`，错误码用封闭集合里的。

## 包的结构
```
packages/<包>/
  package.json        name: @hue/<包>, type: module, exports 指向 src/index.ts
  tsconfig.json       { "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src","test"] }
  README.md           一屏：是什么、怎么用（10 行以内示例）、依赖及理由
  src/index.ts        唯一公共入口
  test/*.test.ts      node:test + node:assert/strict，用 tsx 跑
  DECISIONS.md        本包的决定记录（格式见下）
```

## 完成标准（全部满足才算完）
1. `tsc -p packages/<包>` 零错误（strict）
2. 与你相关的 `@hue/core/contracts` 合同测试在你的测试里调用并全部通过
3. 任务说明里列的额外测试全部通过
4. 预算内
5. `DECISIONS.md` 写完：任务里每个「你来决定」的问题一节，格式：**问题 / 选项 / 选了什么 / 为什么 / 代价 / 以后什么情况下要改**
6. 最后给出一份交接报告（直接回复即可）：做了什么、偏离任务说明的地方、留下的 TODO、需要人审查的最关键的 3 段代码（文件:行号）

## 风格
- 小文件、小函数、少抽象。宁可直白重复两次，也不要过早做通用层。
- 注释写"为什么"，不写"做了什么"。中文英文都可以，一个文件内统一。
- 不要写 class 继承体系；工厂函数 + 对象字面量优先。
