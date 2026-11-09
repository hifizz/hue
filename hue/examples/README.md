# examples/ — 里程碑脚本

用 `@hue/ai` + `@hue/tools` + `@hue/store` + `@hue/core` 拼成一个能改代码的 agent。这是 runtime 出现之前的临时组装，不是产品。

```bash
cd hue
npx tsx --env-file=.env.local examples/agent.ts <仓库目录> "<任务>" [会话id]
```

- 模型默认 `claude-sonnet-5-5`（`HUE_MODEL` 可改），key 和地址读 `AI_GATEWAY_*`。
- 日志写到 `./hue.db`（`HUE_DB` 可改）。用同一个会话 id 再跑一次就是接着聊；上次死在工具执行中途的话，会先补一条 crashed 结果。
- **没有 policy 包**：`bash` 每次都停下来问你 y/n，这是现在唯一的安全措施。`read/edit/write` 不问。
- `local-sandbox.ts` 是临时 sandbox：路径锁在仓库目录内（含符号链接）、命令不继承宿主环境变量（API key 不会泄给 bash）、超时杀整个进程组。**没有容器隔离**，命令仍以你的用户身份运行。`@hue/sandbox` 落地后删掉它。

## 测试

```bash
node --import tsx --test examples/agent.test.ts   # 12 个；npm test 不包含它
npx tsc -p examples
```

用脚本化的假模型跑完整个流程（读 → 改 → 跑测试 → 通过、拒绝执行、越界被拦、崩溃后续写），以及临时 sandbox 过 core 的 `sandboxPortContract`。

## 没验证的

- **只在一个 5 行的演示仓库上用真实模型跑过两次**（`claude-sonnet-5-5`，经中转站）。第一次 5 步，模型用 `bash` 的 `echo > file` 改文件，还试图 `cd` 到一个不存在的目录；在系统提示里加了"不要 cd"之后，第二次 4 步：先跑测试、读代码、用 `edit` 改、再跑测试，没有 `cd`，bug 修好。样本太少，不能说明 `edit` 的说明已经足够。
- 第二次的第一步模型调用花了 98 秒（只输出 60 个 token），其余几步都是 2 到 3 秒，原因不明，可能是中转站排队。还没有在真实仓库里修过真实 bug。
- **bash 不受路径限制**：临时 sandbox 只限制 `cwd` 和文件接口，命令里写 `cd /任意路径` 照样能跑出去。第一次跑时模型就尝试 `cd` 到一个不存在的目录。现在唯一的把关是每次的 y/N，要看清命令碰了哪里。
- 模型自己说"系统提示里写的工作目录是 /tmp/magpie-claude-work-65532"，而我们的 `INSTRUCTIONS` 里没有这个路径，来源不明（中转站或模型），没有排查。
