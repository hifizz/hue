/** 复制到剪贴板：先试 pi-tui 的原生剪贴板，再退到 pbcopy / xclip。 */
import { execFileSync } from 'node:child_process'
import { getNativeClipboard } from '@earendil-works/pi-tui'

export async function copyText(text: string): Promise<boolean> {
  const clip = getNativeClipboard()
  if (clip?.setText) {
    try { await clip.setText(text); return true } catch { /* 再试系统命令 */ }
  }
  try {
    execFileSync('pbcopy', { input: text, stdio: ['pipe', 'pipe', 'ignore'] })
    return true
  } catch {
    try {
      execFileSync('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'pipe', 'ignore'] })
      return true
    } catch { return false }
  }
}
