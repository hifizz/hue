# 第 1 课：最小 agent loop

文件：[loop.ts](loop.ts) · [scripted-model.ts](scripted-model.ts) · [demo.ts](demo.ts) · [loop.test.ts](loop.test.ts)

## 先记住三句话

1. **模型无状态。** 每次请求都要把完整的 messages 重新发一遍。
2. **模型不会执行任何东西。** 它只会"说"想调哪个工具，执行的是你的代码。
3. **所以 agent loop 就是：** 请求模型 → 有工具调用就执行 → 把结果追加进 messages → 再请求。每一次"请求模型"叫一个 **step**。

```
messages = [用户的话]
循环:
  reply = 模型(messages)         ← 一次 step
  messages += reply
  如果 reply 里没有工具调用: 结束
  results = 执行所有工具调用
  messages += results
```

## 数据：一切都是 messages

| 消息 | 内容 |
|---|---|
| `user` | 用户说的话 |
| `assistant` | 模型说的话，内容里可以夹着 `tool-call` |
| `tool` | 工具的执行结果。一条消息装同一步里的所有结果，顺序与 tool-call 一致 |

## 两个接口

- `Model.complete(request)`：收 messages，回一条 assistant 消息和 `finishReason`。
- `Tool.execute(input)`：收参数，返回文本。

模型和工具之间没有直接联系，全靠 loop 在中间传话。

## loop 的六步

| 步骤 | 做什么 | 为什么 |
|---|---|---|
| ① | 调模型，传全部 messages | 模型什么都不记得 |
| ② | 被截断（`length`）就直接结束，且不保留 tool-call | 截断的 tool-call 可能只有一半参数。历史里有 tool-call 却没有 tool-result，下一次请求会被 provider 拒绝 |
| ③ | 没有工具调用就结束 | "自然停止" |
| ④ | 先发出所有 `tool.call` 事件，再并发执行 | 消费者可以在执行前落盘，崩溃后知道执行过什么（Hue 写前日志的雏形） |
| ⑤ | 结果按调用顺序追加 | `Promise.all` 保证顺序与谁先跑完无关 |
| ⑥ | 超过 `maxSteps` 就停 | 保险丝。放在追加结果之后，保证历史始终成对 |

## 工具永远不让 loop 抛错

`runTool` 把未知工具、执行异常都转成 `isError: true` 的结果交给模型：

- API 要求每个 tool-call 必须有一个 tool-result，少一个下一次请求就 400。
- 模型看到错误后常常能自己纠正。demo 里 `1/0` 失败后，模型在第 2 步自己换了算法。

## demo 输出

```
── step 1 ──
  tool.call   calc({"a":12,"op":"*","b":3})
  tool.call   calc({"a":1,"op":"/","b":0})
  tool.result ✓ 36
  tool.result ✗ Error: division by zero
── step 2 ──
  tool.call   calc({"a":36,"op":"+","b":1})
  tool.result ✓ 37
── step 3 ──
  assistant: 12*3=36，36+1=37。1/0 无法计算。

每次收到的 messages 条数: 1 → 3 → 5
```

最后一行是"无状态"的直观样子：模型每次收到的 messages 一路增长。这也是 step 越多成本越高、需要 `maxSteps` 和后面上下文压缩的原因。

## 测试（8 个）

1 步结束 · 每步收到完整历史 · 并行结果保持顺序 · 未知工具和异常不让 loop 崩 · `maxSteps` 能停且历史成对 · 被截断的 tool-call 不执行也不进历史 · abort 后不再调模型 · 续聊时 history 原样发给模型

## 与其他实现的对应

| 本课 | AI SDK | Hue core |
|---|---|---|
| `while(true)` + `maxSteps` | `streamText` 内部的 step 递归 + `stopWhen` | `runTurn` |
| `finishReason` 判断 | `stream-text.ts:2538` 附近的继续条件 | 结束判断 |
| `runTool` 吞异常 | 工具错误变 `tool-error` 输出 | 不变量 6 |
| yield 事件 | 流部件与生命周期回调 | `HueEvent` |

## 故意省掉的东西

流式输出（第 2 课）· 推理块与签名（第 2 课）· 权限与人工确认 · 按副作用等级串行/并发 · 上下文压缩 · 持久化与崩溃恢复 · 参数校验

## 没验证的

- 只用假模型跑过，没接真实 provider。真实模型可能返回部分 JSON、空文本，或其他 `finishReason`。
- abort 测试只覆盖"工具执行中触发"，没测"模型请求进行中触发"。
- 自包含，没有复用 `@hue/core` 的类型。之后要做一次从教学版迁移到 core 的对照。
