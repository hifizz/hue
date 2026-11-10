import type { Effects, Json, PolicyCall, PolicyDecision, PolicyPort } from '@hue/core'
import { globMatch, summarize, testMatcher, type Matcher } from './match.js'
import { splitShell } from './shell.js'

export type Action = 'allow' | 'deny' | 'ask'

export interface Rule {
  /** 工具名，支持 `*`。不写 = 任何工具。 */
  tool?: string
  effects?: Effects
  /** 对 input 的某个字段：正则（只匹配字符串字段）或函数。所有条件都要满足。 */
  match?: Record<string, Matcher>
  action: Action
  /** deny 时给模型看的原因；模型会据此改变做法，所以要写清楚该怎么做。 */
  reason?: string
}

export interface RulesOptions {
  /** 没有规则命中时的决定，默认 ask。 */
  default?: Action
  /** 哪些工具的哪个字段是 shell 命令，匹配前会先拆段。默认 bash 的 command。 */
  shell?: { tools?: readonly string[]; field?: string }
}

const hit = (r: Rule, call: PolicyCall, input: Json): boolean =>
  (r.tool === undefined || globMatch(r.tool, call.tool))
  && (r.effects === undefined || r.effects === call.effects)
  && Object.entries(r.match ?? {}).every(([k, m]) => testMatcher(m, (input as { [k: string]: Json })[k]))

/**
 * 规则自上而下，第一条命中即生效；都没命中走 default。
 * 纯函数，不做 I/O：同样的调用永远得到同样的决定（合同要求）。
 */
export function rules(list: readonly Rule[], opts: RulesOptions = {}): PolicyPort {
  const fallback = opts.default ?? 'ask'
  const shellTools = opts.shell?.tools ?? ['bash']
  const field = opts.shell?.field ?? 'command'

  const first = (call: PolicyCall, input: Json): { action: Action; rule?: Rule; index: number } => {
    const index = list.findIndex(r => hit(r, call, input))
    return index < 0 ? { action: fallback, index } : { action: list[index]!.action, rule: list[index], index }
  }
  const deny = (call: PolicyCall, index: number, why?: string): PolicyDecision => ({
    action: 'deny',
    reason: list[index]?.reason ?? (index < 0 ? `no policy rule allows ${call.tool}` : `${call.tool} is denied by policy (rule #${index + 1})`) + (why ? ` — in: ${why}` : ''),
  })
  const ask = (call: PolicyCall, note = ''): PolicyDecision => ({ action: 'ask', prompt: `Allow ${call.tool}? ${summarize(call)}${note}` })

  return {
    specVersion: 'hue.policy.v1',
    async decide(call) {
      const input = call.input
      const cmd = typeof input === 'object' && input !== null && !Array.isArray(input) ? input[field] : undefined
      if (!shellTools.includes(call.tool) || typeof cmd !== 'string') {
        const r = first(call, input)
        // reason 没写就不带这个键：决定要进事件日志，undefined 字段经 JSON 往返会消失，前后就不相等了。
        return r.action === 'allow' ? (r.rule?.reason ? { action: 'allow', reason: r.rule.reason } : { action: 'allow' }) : r.action === 'deny' ? deny(call, r.index) : ask(call)
      }

      // shell 命令：逐段判断，任何一段 deny 就整条 deny；否则任何一段 ask 就整条 ask；全部 allow 才 allow。
      let asked: string | undefined
      for (const seg of splitShell(cmd)) {
        const r = first(call, { ...(input as { [k: string]: Json }), [field]: seg.text })
        if (r.action === 'deny') return deny(call, r.index, seg.text.slice(0, 80))
        // opaque 段上，只有"看了命令内容才放行"的 allow 规则要降级：规则没法判断它实际会做什么。
        // 不看命令的规则（比如 yolo 的全放行）是用户明确选择，照常生效。
        if (r.action === 'ask' || (r.action === 'allow' && seg.opaque && r.rule?.match && field in r.rule.match)) asked ??= seg.opaque ? ' (contains shell constructs the policy cannot check)' : ''
      }
      return asked === undefined ? { action: 'allow' } : ask(call, asked)
    },
  }
}
