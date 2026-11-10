# @hue/memory

## 职责
跨会话记忆：写入、召回、整理。

## 不做
不做单会话上下文管理（context）。

## 接口草图（非最终）
```ts
export interface MemoryStore { write(m: MemoryItem): Promise<void>; search(q: string, k: number): Promise<MemoryItem[]> }
export const memory: { file(dir: string): MemoryPort }  // 暴露 remember / recall 工具 + 启动时注入摘要
```

## 关键问题
- DONE: 记忆形态——只做 markdown 文件（DECISIONS 第 1 条）
- TODO(deep): 什么时候写——模型主动调用 remember、会话结束反思、还是两者；如何防止写垃圾
- TODO(deep): 召回——启动注入 vs 按需工具 vs 每轮自动检索；如何评估召回质量
- LATER: 遗忘与冲突合并

## 各家怎么做（对照答案）
- TARS / pi-durable 的记忆 TODO(verify)
- Mastra memory（working memory + semantic recall）TODO(verify)
- Claude Code CLAUDE.md / memory 工具 TODO(verify)

## 结论
已实现（`hue/packages/memory`，取舍见该包 DECISIONS.md）：
- 形态：一条一个 markdown 文件（可读、可手改、可进 git），没有向量库。`file(dir)` 返回一个 `Capability`：索引进系统提示，`remember` / `recall` / `forget` 三个工具。
- 写：只有模型主动调用；防垃圾靠硬规则（大小 / 条数 / 命名 / 疑似凭证拒绝 / 同名更新）。召回：索引常驻，正文按需，关键词打分（中文按字和相邻两字）。
- 安全：笔记进提示，等于持久化的提示注入面；只有缓解（声明"不是指令"、`idempotent` 可被 policy 管、日志可查）。
- 没做：真实模型下的验证、"两次会话"的 eval、召回质量评估、遗忘与合并。

## 验收
跨两次会话能记住用户偏好并在 eval 里体现

## 对应 JD
记忆

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
