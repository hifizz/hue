# @hue/policy

core 的 `PolicyPort`：每次工具调用执行前，按规则给出 `allow` / `deny` / `ask`。纯函数，不做 I/O，零运行时依赖。`ask` 由 core 的 loop 经 `InputPort` 去问人，这个包不做任何 UI。

```ts
import { rules, presets, withGrants } from '@hue/policy'

const policy = rules([
  { tool: 'read', action: 'allow' },
  { tool: 'bash', match: { command: /rm -rf|sudo/ }, action: 'deny', reason: '危险命令，换一种做法' },
  { tool: 'bash', match: { command: /^git (status|diff|log)/ }, action: 'allow' },
  { tool: 'fs__*', action: 'ask' },
  { effects: 'none', action: 'allow' },
], { default: 'ask' })

presets.readOnly()   // 只放行 effects: none，其他 deny
presets.coding()     // 编码 agent 的合理默认：看一眼和跑测试的命令放行，危险的拒绝，其余问人
presets.yolo()       // 全部放行，只在容器或一次性副本里用
withGrants(policy, grants)  // 用户点了"总是允许"之后：只把 ask 升级成 allow，不覆盖 deny
```

## 规则怎么判

- **自上而下，第一条命中即生效**；都没命中走 `default`（默认 `ask`）。
- 匹配维度：`tool`（支持 `*`）、`effects`、`match`（对 input 某字段的正则或函数，条件之间是"且"）。
- `deny` 带 `reason`，是写给模型看的；`ask` 带给人看的提示（工具名 + 关键参数，超过 300 字符截断）。
- **bash 命令先拆段再逐段判断**（`;` `&&` `||` `|` `&`、换行）：`git status && rm -rf ~` 不会因为开头像 `git status` 就整条放行。看不透的结构（`$(…)`、反引号、heredoc、写文件的重定向等）上，要看命令内容才放行的 allow 规则会降级成 ask。
- **这不是安全边界**，真正的边界是 sandbox。能绕过的办法写在 [DECISIONS.md](DECISIONS.md) 第 3 条。

## 测试

```bash
cd hue
npx tsc -p packages/policy
node --import tsx --test packages/policy/test/policy.test.ts   # npm test 也会跑
```

三个预设都过 core 的 `policyPortContract`，另有规则顺序、通配、确定性、绕过尝试、`withGrants` 的测试。

## 没验证的

- 绕过测试只覆盖了我想到的写法；分词器不是 shell 解析器。
- 没有在真实 agent 跑里用过 `presets.coding()`：白名单是否合适（太松或太严）要看真实使用。
- 规则不能从 JSON 加载，见 [DECISIONS.md](DECISIONS.md) 第 2 条。
