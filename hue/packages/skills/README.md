# @hue/skills

发现 `SKILL.md` 目录，把"每个技能一行"放进系统提示，模型需要时用 `load_skill` 工具读全文和附带文件。是 core 的一个 `Capability`，只依赖 `@hue/core`，不引第三方库。

```ts
import { fromDir } from '@hue/skills'

createAgent({ model, store, capabilities: [fromDir(['./.hue/skills', '~/.hue/skills'])] })  // 靠前的目录盖过靠后的
```

目录布局兼容 Anthropic Agent Skills：`<目录>/<名字>/SKILL.md`，开头 frontmatter 要有 `name`（小写字母、数字、连字符，和目录名一致）和 `description`。

```
.hue/skills/pdf/SKILL.md          ← 正文是给模型的说明
.hue/skills/pdf/scripts/fill.py   ← 附带文件，模型用 load_skill file=scripts/fill.py 读
```

- **索引**：系统提示里只有一句用法加每个技能一行（`- 名字: 描述`，描述压成一行、最多 200 字符）。正文不进上下文，直到模型调 `load_skill`。
- **`load_skill({ name, file? })`**：不给 `file` 返回去掉 frontmatter 的正文和附带文件清单；给了就读那个文件（只能在技能目录内，≤ 100KB，文本）。只读，`effects: 'none'`。
- **不执行**：技能带的脚本不会被运行，模型读出来、自己用 `bash` 跑。
- 每个 turn 开始时重新扫描：新加的技能下个 turn 生效。没有任何技能时既不加说明也不加工具。
- 不合法的技能（没有 frontmatter、名字不对、缺描述）被跳过，原因通过 `capability.scan().problems` 拿到。

## 测试

```bash
cd hue
npx tsc -p packages/skills
node --import tsx --test packages/skills/test/*.test.ts      # npm test 也会跑
```

覆盖：frontmatter 解析、扫描与优先级、索引、`load_skill` 的各种路径与越界（`../`、绝对路径、符号链接、同前缀的兄弟目录）、一个用真 core loop 的集成。

## 没验证的

- 没有用真实模型跑过：不知道模型会不会在该用的时候调 `load_skill`，也不知道一行描述够不够它判断。
- frontmatter 不是完整 YAML：列表、嵌套会被忽略，只认 `key: value` 和 `>` / `|` 续行。
- 没有拿真实的 Anthropic 技能（如官方 pdf、docx 技能）试过兼容性。
