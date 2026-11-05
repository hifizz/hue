# @hue/store

## 职责
事件日志持久化、会话列表、回放。

## 不做
不做记忆语义（memory 的事）。

## 接口草图（非最终）
```ts
export interface Store { append(sessionId: string, e: HueEvent): Promise<void>; read(sessionId: string): AsyncIterable<HueEvent> }
export const sqlite: (path: string) => Store
export const memoryStore: () => Store
```

## 关键问题
- TODO(deep): 回放与恢复——从日志重建 history；崩溃在工具执行中途怎么办（TARS：副作用不重放）
- DECIDE: 存原始事件还是存派生的 Message 快照，或两者
- DECIDE: 分支（fork 会话）求职版要不要

## 各家怎么做（对照答案）
- Pi durable 的持久化方式 TODO(verify)
- Mastra storage 适配器分目录 TODO(verify)

## 结论
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
kill -9 后重启能继续同一会话

## 对应 JD
Agent 内核

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
