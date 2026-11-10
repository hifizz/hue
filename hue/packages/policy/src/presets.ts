import type { PolicyPort } from '@hue/core'
import { rules, type Rule } from './rules.js'

// 编码 agent 里"看一眼"和"跑项目自己的测试、构建"的命令。只匹配每段开头，逐段判断，所以 `ls | head` 两段都过。
// `node <脚本>` 放行是因为运行项目自己的代码正是编码 agent 要做的事；这不是安全边界，边界是 sandbox。
const SAFE_COMMAND = new RegExp('^(' + [
  'git\\s+(status|diff|log|show|rev-parse)\\b', 'git\\s+branch\\s*(-[ar]|--list)?$',
  'ls\\b', 'pwd$', 'cat\\s', 'head\\b', 'tail\\b', 'wc\\b', 'grep\\b', 'rg\\b', 'echo\\b', 'which\\s', 'true$',
  'node\\s+(--test\\b|[^-\\s]\\S*)', 'npm\\s+(test|run\\s+(test|build|lint|check|typecheck))\\b', 'npx\\s+tsc\\b', 'tsc\\b',
  'pytest\\b', 'python3?\\s+-m\\s+pytest\\b', 'cargo\\s+(test|check|build)\\b', 'go\\s+(test|build|vet)\\b',
].join('|') + ')')

// 无论如何不能做的：提权、对根目录 / 家目录 / 上级目录 / 通配符的递归删除、强制推送、直接写磁盘。
// `rm -rf node_modules` 这种不在此列，它会落到默认的 ask。
const DANGEROUS: Rule[] = [
  { tool: 'bash', match: { command: /^(sudo|su|doas)\b/ }, action: 'deny', reason: 'Privilege escalation is not allowed. Run the command without sudo, or ask the user to do it.' },
  { tool: 'bash', match: { command: /^rm\s+(-\S+\s+)*(\/\*?|~|\$HOME|\.\.|\*)(\s|\/|$)/ }, action: 'deny', reason: 'Deleting the root, home, parent directory or everything with * is not allowed. Delete specific paths inside the project instead.' },
  { tool: 'bash', match: { command: /^git\s+push\b.*(--force\b|\s-f\b|--force-with-lease\b)/ }, action: 'deny', reason: 'Force-pushing is not allowed.' },
  { tool: 'bash', match: { command: /^(mkfs\S*|dd)\b/ }, action: 'deny', reason: 'Writing directly to disks is not allowed.' },
]

export const presets = {
  /** 只放行没有副作用的工具，其他一律拒绝。适合只读问答。 */
  readOnly: (): PolicyPort => rules([
    { effects: 'none', action: 'allow' },
    { action: 'deny', reason: 'Read-only mode: only tools without side effects are available. Do not try to modify anything.' },
  ]),

  /** 编码 agent 的合理默认。extra 先于内置规则判断，可以用来加项目特有的放行或禁止。 */
  coding: (extra: Rule[] = []): PolicyPort => rules([
    ...extra,
    ...DANGEROUS,
    { effects: 'none', action: 'allow' },
    { tool: 'edit', action: 'allow' },
    { tool: 'write', action: 'allow' },
    { tool: 'bash', match: { command: SAFE_COMMAND }, action: 'allow' },
  ], { default: 'ask' }),

  /** 全部放行。只在已经隔离的环境里用（容器、一次性副本）。 */
  yolo: (): PolicyPort => rules([{ action: 'allow' }]),
}
