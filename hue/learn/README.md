# learn/：教学版 agent loop

这里是一组循序渐进的小课，目的是把 harness 最核心的循环从零写一遍，每课只加一个新问题。
代码自包含，**不依赖 `@hue/core`**，也不需要网络和 API key。

## 课程

| 课 | 主题 | 解决的问题 | 核心代码行数（不含测试、夹具、demo） |
|---|---|---|---|
| [01-minimal-loop](01-minimal-loop/README.md) | 最小 agent loop | 模型无状态、不能执行工具，循环怎么把它们接起来 | `loop.ts` 158 行 |
| [02-streaming](02-streaming/README.md) | 流式 | 回复是一块块到的，怎么拼成完整消息；半路断了怎么办 | 4 个文件共 401 行（sse 47 + anthropic 138 + loop 164 + types 52） |

计划中的下一课（未开始）：接真实 API 验证前两课的假设；工具的并发、副作用等级与权限。

## 怎么运行

`learn/` 在 `hue/` 里面，直接用 `hue/` 装好的 `typescript` 和 `tsx`，也沿用 `hue/package.json` 的 `"type": "module"`，不需要自己的 `package.json`。命令都在 **`hue/` 目录下**执行（先 `npm install`）：

```bash
npx tsc -p learn                                               # 类型检查
node --import tsx --test learn/01-minimal-loop/loop.test.ts    # 第 1 课测试
node --import tsx --test learn/02-streaming/streaming.test.ts  # 第 2 课测试
npx tsx learn/01-minimal-loop/demo.ts                          # 看事件流
npx tsx learn/02-streaming/demo.ts
```

注意：`npm test` 只跑 `packages/*/test`，**不包含 learn/**，要单独运行上面的命令。

## 约定

- 每课一个目录，含 `loop.ts`（本课核心）、`demo.ts`（可运行的演示）、`*.test.ts`（离线测试）、`README.md`（本课说明）。
- 后一课可以 import 前一课的导出，但不改它的行为。
- 模型用"假模型"（按剧本回复），保证每次运行结果完全确定。
- 与 `packages/core` 的关系：learn 是骨架，core 是加固后的版本。读完这里再读 `packages/core/src/loop.ts`，看多出来的每一块在解决什么问题。
