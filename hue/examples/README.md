# examples/ — 里程碑脚本

经 `@hue/runtime` 把 `@hue/ai` + `tools` + `store` + `sandbox` + `policy` + `context` 拼成一个能改代码的 agent。这是演示脚本，不是产品。

```bash
cd hue
npx tsx --env-file=.env.local examples/agent.ts <仓库目录> "<任务>" [会话id]
```

- 模型默认 `claude-sonnet-5-5`（`HUE_MODEL` 可改），key 和地址读 `AI_GATEWAY_*`。
- 日志写到 `./hue.db`（`HUE_DB` 可改）。上次死在工具执行中途的话，会先补一条 crashed 结果。
- **默认 `HUE_SANDBOX=docker`**：把仓库 `git clone` 到临时目录，容器只挂载这份副本。agent 的 `bash` 在容器里跑，不再逐条确认；原仓库不动。
  - 镜像 `HUE_IMAGE`（默认 `node:22`），网络 `HUE_NETWORK`（默认 `bridge`，能联网；`none` 断网）。
  - 副本只含已提交的内容，不含 `node_modules`（宿主的二进制依赖在 Linux 容器里跑不了），需要时 agent 会在容器里装。
  - 跑完会打印副本路径，以及看改动、采纳到原仓库的命令：`git -C <副本> diff` 和 `git -C <副本> diff | git -C <原仓库> apply`。
  - 续聊同一个会话：同一个会话 id，加 `HUE_COPY=<副本路径>` 复用副本。
- `HUE_SANDBOX=local`：不隔离，命令以你的用户身份运行，看一眼和跑测试的命令放行，危险的拒绝，其余停下来问 y/N。要在交互式终端里运行。
- `HUE_TRACE=trace.jsonl`：把实际发给模型的请求体和响应头逐行写进文件（不含 key）。事件日志里没有这些，想知道"中转站有没有改系统提示"就看它。文件里有完整的提示和代码内容，别提交。
- 上下文用 `@hue/context`：`chain(foldToolResults(), summarize({ model }))`，估算超过窗口 80% 就压。长任务里只有折叠真正起作用，见 `packages/context/DECISIONS.md` 第 0 条。
- 策略用 `@hue/policy`：docker 模式 `presets.yolo()`（容器是边界），local 模式 `presets.coding()`（看一眼和跑测试的命令放行、危险的拒绝、其余问你 y/N）。

## 回放查看器

```bash
npx tsx examples/replay.ts                     # 列出 ./hue.db 里的会话
npx tsx examples/replay.ts ./hue.db <会话id>   # 打印时间线
```

按时间线显示每步模型耗时和 token（含缓存读写）、每次工具调用与结果、你批准等了多久、被拒绝和失败的调用，末尾给出合计和缓存命中率。只读日志，不依赖别的包。

## 测试

```bash
node --import tsx --test examples/*.test.ts      # agent 5 个 + replay 3 个；npm test 不包含它
npx tsc -p examples
```

用脚本化的假模型跑完整个流程（读 → 改 → 跑测试 → 通过、拒绝执行、越界被拦、崩溃后续写），以及一个跑在 docker 里的用例（没有 Docker 时 skip）。sandbox 本身的测试在 `packages/sandbox/test/`。

## 没验证的

- **docker 模式用真实模型跑过**：`glm-5.3-flash`（经中转站），在 5 行的演示仓库上 5 到 6 步修好，`bash` 在容器里真正执行了 `node test.js`（先复现失败，改完输出 `ok`）。同样只是一个小样本；`node:22` 镜像是用国内镜像源拉取后打的 tag。
- **local 模式用真实模型跑过两次**，都是在一个 5 行的演示仓库上（`claude-sonnet-5-5`，经中转站）：第一次 5 步，模型用 `bash` 的 `echo > file` 改文件，还试图 `cd` 到一个不存在的目录；在系统提示里加了"不要 cd"后，第二次 4 步，用 `edit` 改，没有 `cd`。样本太少，不能说明 `edit` 的说明已经足够。
- 第二次的第一步模型调用花了 98 秒（只输出 60 个 token），其余几步 2 到 3 秒，原因不明，可能是中转站排队。
- 模型说"系统提示里写的工作目录是 /tmp/magpie-claude-work-65532"，而我们的 `INSTRUCTIONS` 里没有这个路径。很可能是中转站或外层往系统提示里加了环境块，未证实，暂不排查。
- 还没有在真实仓库里修过真实 bug。
- 默认联网：容器里的命令能把副本里的内容发出去，副本里有密钥时要用 `HUE_NETWORK=none`。
- 回放查看器只用构造的事件和一份演示会话验证过格式；原始请求要开 `HUE_TRACE` 才有（还没用它查过那个路径的来源）。
