# learn/：教学版 agent loop

这里是一组循序渐进的小课，目的是把 harness 最核心的循环从零写一遍，每课只加一个新问题。
代码自包含，**不依赖 `@hue/core`**。前两课完全离线；第 3 课的测试也是离线的（用假 fetch），只有 `live-demo.ts` 和一个被 skip 的测试需要真实的 `ANTHROPIC_API_KEY`。

## 课程

| 课 | 主题 | 解决的问题 | 核心代码行数（不含测试、夹具、demo） |
|---|---|---|---|
| [01-minimal-loop](01-minimal-loop/README.md) | 最小 agent loop | 模型无状态、不能执行工具，循环怎么把它们接起来 | `loop.ts` 158 行 |
| [02-streaming](02-streaming/README.md) | 流式 | 回复是一块块到的，怎么拼成完整消息；半路断了怎么办 | 4 个文件共 411 行（sse 47 + anthropic 146 + loop 164 + types 54） |
| [03-real-api](03-real-api/README.md) | 接真实 API | 消息转换、签名往返、错误分类、重试退避、取消、释放连接 | 3 个文件共 269 行（request 81 + http 104 + client 84） |

第 3 课**还没有对真实 API 跑通过**（写的时候没有 key），详见它的 README 里"没验证的"。

计划中的下一课（未开始）：工具的并发、副作用等级与权限。注意根目录 `README.md` 的优先级是先打通一个能跑的 agent，所以下一步也可能是把第 3 课的代码迁成 `@hue/ai`，而不是继续加课。

## 怎么运行

`learn/` 在 `hue/` 里面，直接用 `hue/` 装好的 `typescript` 和 `tsx`，也沿用 `hue/package.json` 的 `"type": "module"`，不需要自己的 `package.json`。命令都在 **`hue/` 目录下**执行（先 `npm install`）：

```bash
npx tsc -p learn                                               # 类型检查
node --import tsx --test learn/01-minimal-loop/loop.test.ts    # 第 1 课测试
node --import tsx --test learn/02-streaming/streaming.test.ts  # 第 2 课测试
node --import tsx --test learn/03-real-api/real-api.test.ts    # 第 3 课测试（没有 key 时 1 个 skip）
npx tsx learn/01-minimal-loop/demo.ts                          # 看事件流
npx tsx learn/02-streaming/demo.ts
ANTHROPIC_API_KEY=... npx tsx learn/03-real-api/live-demo.ts   # 真实调用，会产生少量费用
```

注意：`npm test` 只跑 `packages/*/test`，**不包含 learn/**，要单独运行上面的命令。

## 约定

- 每课一个目录，含 `loop.ts`（本课核心）、`demo.ts`（可运行的演示）、`*.test.ts`（离线测试）、`README.md`（本课说明）。
- 后一课可以 import 前一课的导出。原则上不改前一课的行为；如果写后一课时发现前一课有缺陷，就修，并在后一课的 README 里写明（第 3 课修了第 2 课的 `redacted_thinking`）。
- 模型用"假模型"（按剧本回复），保证每次运行结果完全确定。
- 与 `packages/core` 的关系：learn 是骨架，core 是加固后的版本。读完这里再读 `packages/core/src/loop.ts`，看多出来的每一块在解决什么问题。
