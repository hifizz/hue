# @hue/tools

编码 agent 用的内置工具：`read` `list` `glob` `grep` `edit` `write` `bash`。所有 I/O 都走 `ctx.sandbox`，换执行环境不用改工具。零运行时依赖。

目前只有内置工具；MCP client 是另一个任务，还没做。

```ts
import { codingTools } from '@hue/tools'
import { runTurn } from '@hue/core'

// codingTools 顺序固定（工具列表是 prompt cache 前缀的一部分）
runTurn({ /* … */ tools: codingTools({ cwd: '/path/to/repo' }) })
```

也可以单个用：`read({ cwd })`、`bash({ timeoutMs: 60_000, maxOutputBytes: 10_000 })`。

| 工具 | effects | 说明 |
|---|---|---|
| `read` | none | 带行号；`offset`/`limit` 分页；二进制不给内容 |
| `list` | none | 列一个目录，目录在前 |
| `glob` | none | 按名字模式找文件（rg，退回 find） |
| `grep` | none | 正则搜内容（rg，退回 grep -E） |
| `edit` | idempotent | 精确字符串替换，要求匹配唯一或 `replace_all` |
| `write` | idempotent | 整文件写入，自动建父目录 |
| `bash` | unsafe | 经 sandbox.exec；超时、非零退出码当错误、输出头尾截断 |

返回给模型的文本不超过 `maxOutputBytes`（默认 30 KB）。没有 `ctx.sandbox` 时返回明确的错误结果。

## 测试

```bash
cd hue
npx tsc -p packages/tools
node --import tsx --test packages/tools/test/*.test.ts   # 62 个，npm test 也会跑
```

每个工具都过 core 的 `toolContract`。edit/read/bash 等用内存版 fake sandbox；glob/grep 另外用**真 shell** 跑（含没有 rg 的回退分支）。

## 没验证的

- **没接过真实模型。** 工具的 description 是否能让模型用对，只有跑 agent 才知道。
- **没接过真正的 `@hue/sandbox`**（还没实现）。路径越界目前没有任何一层拦截，见 [DECISIONS.md](DECISIONS.md) 第 2 条。
- **bash 没有权限控制**（policy 未实现），根目录 README 的里程碑文档要写明这点。
- 30 KB 截断上限是经验值，没用真实任务调过。
- 没有 MCP 部分；`src/index.ts` 只导出 builtin。
