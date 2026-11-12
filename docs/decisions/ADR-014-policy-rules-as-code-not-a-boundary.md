# ADR-014 policy：规则是 TypeScript 值；bash 分词只降低误放行，不是安全边界
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/policy
- 来源标记：`DECIDE: 规则格式（allowlist / glob / 函数）`（docs/packages/deferred.md:5）

## 问题
权限规则怎么写、怎么存？bash 命令怎么判断？

## 候选
1. 规则是 TypeScript 值，`match` 可以是正则或函数。
2. 规则可从 JSON 加载（需要发明"字符串正则 + 内置谓词"的格式）。
3. bash 命令：整条匹配 / 分词后逐段匹配 / 写完整 shell 解析器。

## 各家怎么做（附出处）
没有核实过。

## 决定
- 规则是 TypeScript 值，不支持 JSON。正则和函数没法直接序列化，求职版没人需要配置文件规则。
- bash 命令分词：按 `; & && | ||` 和换行拆段（引号内不拆），每段单独过规则；任一段 deny 则整条 deny，任一段 ask 则整条 ask，全部 allow 才 allow。看不透的结构（`$(…)`、反引号、heredoc、子 shell、变量开头、写文件重定向、引号未闭合）标成 opaque，依赖命令内容的 allow 规则在 opaque 段上降级成 ask。
- "总是允许"由 `withGrants(policy, grants)` 提供，grants 的持久化交给 runtime（写成 `ext` 事件）；只把 ask 升级成 allow，永远不覆盖 deny。
- `presets.coding()` 的放行 / 拒绝清单是**猜的**，没用真实任务调过。

**这不是安全边界。** 真正的边界是 sandbox（Docker）。已知能绕过或放得过松：`cat <任意文件>` 在 local 沙箱里能读 `~/.ssh`；`git diff --output=<文件>` 会写文件；`npm test` 会执行 `package.json` 里的任意脚本；别名、函数、`eval`；分词器与真实 shell 的差异。

## 代价
复杂但无害的命令（带 `$(…)`）会多问一次。用户不能用配置文件写规则。grants 只能按"工具名 + 字段逐字相等"匹配。

## 何时要改
做 gateway / 配置文件时加 `fromJSON`；发现误问太多或有人构造出绕过时，先补测试再改分词。

## 如何验证（eval / 测试）
- `policy/test/policy.test.ts`：`rm -rf /` 的各种写法被 deny；`splitShell` 的分段（含注释、引号）；`withGrants` 只把 ask 升级成 allow、deny 不被覆盖；带 `g` 标志的正则不会因 `lastIndex` 对同一输入给出不同结果。
- **白名单没经过真实任务验证**。
