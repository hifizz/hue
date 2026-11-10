# @hue/memory

跨会话的记忆：一条一个 markdown 文件，能读、能手改、能进 git。是 core 的一个 `Capability`：启动时把索引（一条一行）放进系统提示，给模型 `remember` / `recall` / `forget` 三个工具。只依赖 `@hue/core`，不引第三方库。

```ts
import { file } from '@hue/memory'

createAgent({ model, store, capabilities: [file('./.hue/memory')] })
```

```
.hue/memory/commit-style.md
---
name: commit-style
description: User wants conventional commits
updated: 2026-11-10T08:00:00.000Z
---
Use feat:/fix: prefixes.
```

- **写**：模型主动调 `remember({ name, description, content })`；同名就是更新。提示里写明了该存什么（用户的偏好和纠正、代码里看不出的项目事实）、不该存什么（代码里能看到的、凭证、当前任务的状态）。
- **防垃圾**：名字 `[a-z0-9_-]` ≤ 64；描述一行 ≤ 160；正文 ≤ 4000 字符；最多 200 条；疑似凭证（私钥、`sk-…`、`AKIA…`、`ghp_…`、`password=…`）拒绝并告诉模型原因。
- **读**：提示里是索引（最新的 50 条，名字加描述）；要正文调 `recall({ query })`，关键词打分（名字 > 描述 > 正文，中文按字和相邻两字），返回前 5 条全文。没有向量、没有每轮自动检索。
- 你可以直接手写 / 手改文件：没有 frontmatter 的文件也能读，描述取第一行。
- `file()` 返回值上还有 `list()` / `search()` / `remember()` / `forget()`，给不经过模型的场景用。

## 测试

```bash
cd hue
npx tsc -p packages/memory
node --import tsx --test packages/memory/test/*.test.ts      # npm test 也会跑
```

覆盖：分词与打分（含中文）、写入格式与更新、各种拒绝、`forget` 不会删到目录外、手写笔记、索引、三个工具、一个跨两个全新会话（真 core loop）的用例；`examples/capabilities.test.ts` 再用真 runtime 跑一遍 skills + memory。

## 没验证的

- **召回质量没量过**：关键词打分在几十条以内够用，不知道几百条时怎样，也没和向量检索比过。
- 没有用真实模型跑过：不知道模型会不会在该存的时候存、存得是否有用、是否会存垃圾。验收里"跨两次会话记住用户偏好并在 eval 里体现"只有机制的测试，没有 eval。
- 密钥拦截只认几种常见形状，拦不住所有。
- 没有遗忘与冲突合并（设计页标 `LATER`）；两个进程同时写同一条笔记，后写的赢。
- 笔记会作为提示的一部分送给模型，见 DECISIONS 第 4 条的安全说明。
