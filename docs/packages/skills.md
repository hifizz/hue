# @hue/skills

## 职责
发现和渐进加载 SKILL.md：先给模型描述，命中再读全文和附带文件。

## 不做
不做跨会话学习（memory）。

## 接口草图（非最终）
```ts
export const skills: { fromDir(dir: string): SkillSource }
// 运行时：把 skill 索引注入 system prompt，暴露 load_skill 工具
```

## 关键问题
- DONE: 加载方式——专门的 load_skill 工具（hue/packages/skills/DECISIONS.md 第 1 条；Claude Code 做法 TODO(verify)）
- DONE: skill 能带脚本，但不执行；模型读出来自己在沙箱里跑（DECISIONS 第 3 条）。skills 与 memory 的边界：skills 是人写的、只读的说明，memory 是模型写的笔记。
- DONE: 兼容 Anthropic Agent Skills 格式（DECISIONS 第 2 条）

## 各家怎么做（对照答案）
- Anthropic Agent Skills 规范 TODO(verify)
- Pi skills TODO(verify)

## 结论
已实现（`hue/packages/skills`，取舍见该包 DECISIONS.md）：
- 兼容 Anthropic Agent Skills 目录布局（`<名字>/SKILL.md` + `name` / `description`）；`fromDir(dir | dirs)` 返回一个 `Capability`。
- 系统提示里每个技能一行；加载用专门的 `load_skill` 工具（不让模型 `read`，因为沙箱里看不到技能目录）；技能自带的文件通过同一个工具读，限制在技能目录内；**不执行**脚本，模型读出来自己在沙箱里跑。
- 还没做：eval 里"需要技能才能完成"的任务、真实模型下的验证、第三方技能的审核。

## 验收
索引注入 ≤ 每个 skill 一行；eval 里有需要 skill 才能完成的任务

## 对应 JD
Skills

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
