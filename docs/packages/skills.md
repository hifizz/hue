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
- DECIDE: 加载方式——工具调用 load_skill vs 让模型直接 read 文件（Claude Code 做法 TODO(verify)）
- TODO(deep): skills 和 tools、memory 的边界——一个 skill 能带脚本吗？谁执行？
- DECIDE: 兼容 Anthropic Agent Skills 格式（frontmatter name/description）

## 各家怎么做（对照答案）
- Anthropic Agent Skills 规范 TODO(verify)
- Pi skills TODO(verify)

## 结论
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
索引注入 ≤ 每个 skill 一行；eval 里有需要 skill 才能完成的任务

## 对应 JD
Skills

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
