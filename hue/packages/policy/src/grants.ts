import type { Json, PolicyPort } from '@hue/core'
import { globMatch } from './match.js'

/** 用户点了"总是允许"之后留下的记录。可序列化（runtime 把它写成 ext 事件）。 */
export interface Grant {
  tool: string
  /** 这些字段必须与调用的 input 逐字相等（按 JSON 文本比较，适合字符串字段，比如整条 bash 命令）。 */
  input?: Record<string, Json>
}

/**
 * 在一个策略外面套一层"已授权"：只把 ask 升级成 allow，永远不覆盖 deny。
 * grants 可以是数组（按引用读，runtime 往里 push 就立刻生效）或返回数组的函数。
 */
export function withGrants(base: PolicyPort, grants: readonly Grant[] | (() => readonly Grant[])): PolicyPort {
  return {
    specVersion: 'hue.policy.v1',
    async decide(call, signal) {
      const d = await base.decide(call, signal)
      if (d.action !== 'ask') return d
      const fields = (typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input) ? call.input : {}) as { [k: string]: Json }
      const list = typeof grants === 'function' ? grants() : grants
      const granted = list.some(g => globMatch(g.tool, call.tool)
        && Object.entries(g.input ?? {}).every(([k, v]) => JSON.stringify(fields[k]) === JSON.stringify(v)))
      return granted ? { action: 'allow', reason: 'granted by the user earlier' } : d
    },
  }
}
