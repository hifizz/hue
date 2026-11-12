import type { HueEvent } from '@hue/core'

export function textPrinter(out: (s: string) => void = s => process.stdout.write(s)): (e: HueEvent) => void {
  return e => {
    if (e.type === 'model.delta') out(e.kind === 'text' ? e.delta : '')
    else if (e.type === 'tool.call') out(`\n▶ ${e.name} ${JSON.stringify(e.input).slice(0, 200)}\n`)
    else if (e.type === 'tool.result' && e.isError) out(`  ✗ ${e.content.map(c => (c.type === 'text' ? c.text : '')).join('').slice(0, 200)}\n`)
    else if (e.type === 'turn.ended') out(`\n\n结束: ${e.reason}，${e.steps} 步，usage=${JSON.stringify(e.usage)}${e.error ? `，${e.error.message}` : ''}\n`)
  }
}

export function jsonPrinter(out: (s: string) => void = s => process.stdout.write(s)): (e: HueEvent) => void {
  return e => out(`${JSON.stringify(e)}\n`)
}
