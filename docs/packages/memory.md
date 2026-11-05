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
- DECIDE: 记忆形态——markdown 文件（可读、可编辑）vs 向量库 vs 两者。可读性符合 Hue 承诺
- TODO(deep): 什么时候写——模型主动调用 remember、会话结束反思、还是两者；如何防止写垃圾
- TODO(deep): 召回——启动注入 vs 按需工具 vs 每轮自动检索；如何评估召回质量
- LATER: 遗忘与冲突合并

## 各家怎么做（对照答案）
- TARS / pi-durable 的记忆 TODO(verify)
- Mastra memory（working memory + semantic recall）TODO(verify)
- Claude Code CLAUDE.md / memory 工具 TODO(verify)

## 结论
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
跨两次会话能记住用户偏好并在 eval 里体现

## 对应 JD
记忆

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
