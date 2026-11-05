# 任务：@hue/policy —— 工具调用权限

**预算** 400 行 · **依赖** core · **合同** `policyPortContract`

## 目标
实现 core 的 `PolicyPort`：每次工具调用执行前给出 allow / deny / ask。ask 由 loop 经 InputPort 问人（core.md D7），本包不做任何 UI。

## 对外 API
```ts
import { rules, presets } from '@hue/policy'
const p = rules([
  { tool: 'read', action: 'allow' },
  { tool: 'bash', match: { command: /^git (status|diff|log)/ }, action: 'allow' },
  { tool: 'bash', match: { command: /rm -rf|sudo/ }, action: 'deny', reason: '危险命令' },
  { tool: 'fs__*', action: 'ask' },
  { effects: 'none', action: 'allow' },
], { default: 'ask' })
presets.readOnly()      // 只放行 effects: none，其他 deny
presets.coding()        // 编码 agent 的合理默认
presets.yolo()          // 全部 allow（测试和沙箱里用）
```

## 必须做到
1. 规则自上而下，**第一条命中即生效**（可预测、好解释）。
2. 匹配维度：工具名（支持 `*` glob）、effects、对 input 某字段的正则或函数。
3. deny 必须带 reason（模型会读到并改变做法）；ask 必须带给人看的 prompt（含工具名和关键参数的摘要，长参数截断）。
4. 纯函数、确定性：同样的输入同样的决定；不做 I/O。
5. 过 `policyPortContract`，至少 15 个用例覆盖三个预设。

## 你来决定
- **"记住这次决定"**（用户点了"总是允许"）放在哪：建议 policy 只提供 `withGrants(policy, grants)` 组合函数，grants 的持久化交给 runtime（写成 `ext` 事件）。
- 规则格式要不要支持从 JSON 文件加载（正则怎么序列化）。
- bash 命令的匹配是否先做简单分词（防 `git status; rm -rf /` 绕过）。建议做：按 `; && || |` 拆开，每段都要通过 allow 规则才 allow。写进 DECISIONS 并承认它不是安全边界——真正的边界是 sandbox。

## 额外测试
- 绕过尝试：`git status && rm -rf ~`、换行注入、`$(...)`。
- 规则顺序的测试。

## 不做
审批 UI、持久化、网络。
