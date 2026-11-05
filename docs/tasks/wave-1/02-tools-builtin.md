# 任务：@hue/tools（内置工具部分）

**预算** tools 整包 1600 行，内置部分约 700 · **依赖** core · **合同** `toolContract` · **目录** 只改 `packages/tools/src/builtin/` 和对应测试（MCP 部分由另一个任务做，`src/index.ts` 两边各加一行导出）

## 目标
编码 agent 需要的 6 个工具，全部通过 `ctx.sandbox` 做 I/O（不直接用 fs / child_process），这样换执行环境不用改工具。

| 工具 | effects | 说明 |
|---|---|---|
| `read` | none | 读文件，带行号；`offset`/`limit`；二进制给提示不给内容 |
| `list` | none | 列目录 |
| `glob` | none | 按模式找文件（经 sandbox.exec 调 `find`/`rg --files`，或在 list 之上实现） |
| `grep` | none | 经 sandbox.exec 调 `rg`，没有 rg 时退回 `grep -rn` |
| `edit` | idempotent* | 修改文件（格式见下面的决定） |
| `write` | idempotent | 整文件写入 |
| `bash` | unsafe | 经 sandbox.exec；超时、截断输出 |

*edit 用"精确字符串替换"时同一调用重复执行第二次会因找不到原文而失败，结果是安全的，所以标 idempotent。

## 必须做到
1. 每个工具导出工厂函数：`read(opts?)`、`bash({ timeoutMs?, maxOutputBytes? })` 等，返回 core 的 `Tool`。另导出 `codingTools(opts?)` 返回全套数组（顺序固定，缓存友好）。
2. 每个工具实现 `parse`（手写校验或极小的 schema 校验函数，不引入 zod 也可以），错误信息要让模型能看懂并改正。
3. **输出截断**：任何工具返回给模型的文本不超过 `maxOutputBytes`（默认 30KB）；截断时保留头尾，中间写明省略了多少、以及怎么看完整内容（如用 read 的 offset）。
4. 没有 `ctx.sandbox` 时返回明确的错误结果，而不是崩溃。
5. 尊重 `ctx.signal`；bash 长输出时用 `ctx.progress` 报进度（可选）。
6. description 是模型唯一的说明书：写清楚何时用、参数含义、限制。每个 ≤ 600 字符。

## 你来决定
- **edit 的格式**：精确字符串替换（Claude Code 式 old_string/new_string）/ 行号 patch / unified diff。建议精确替换：最不容易被模型写错，失败时错误信息最明确（"找到 0 处 / 找到 3 处，请加更多上下文"）。写出对比表，这是一篇好的拆解文章素材。
- **路径**：是否强制相对 workdir、如何处理 `..`。建议工具只做规范化，越界拦截交给 sandbox。
- **截断策略**的具体数值。

## 额外测试
- 用一个内存版 fake sandbox（测试内自己写，不放 src）跑所有工具。
- edit：0 处匹配、多处匹配、成功替换、CRLF 文件。
- bash：超时、非零退出码、输出超长被截断。
- 每个工具过 `toolContract`。

## 不做
不做权限（policy）、不做隔离（sandbox）、不做 MCP。
