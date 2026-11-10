/**
 * 把一条 shell 命令粗拆成"依次执行的几段"，让规则能逐段判断。
 * 这不是 shell 解析器，只做一件事：防止 `git status; rm -rf ~` 因为开头像 `git status` 就整条放行。
 *
 * 拆分点：`;` `&` `&&` `|` `||` 和换行（引号里的不拆）。
 * 看不透的结构标成 opaque：命令替换（`$(...)`、反引号）、进程替换、heredoc、子 shell / 分组、
 * 以变量开头的命令、会写文件的重定向、引号没闭合。opaque 段上 allow 规则不生效（最多 ask）。
 */
export interface Segment {
  text: string
  /** 策略无法静态判断这一段到底会做什么 */
  opaque: boolean
}

// 这两种重定向无害：`2>&1`（复制文件描述符）和丢给 /dev/null。剩下的 `>` 才是写文件。
const HARMLESS_REDIRECT = [/\d*>&\d+/g, /\d*>>?\s*\/dev\/null/g]

function isOpaque(bare: string): boolean {
  if (/^[$({]/.test(bare) || /<<|<\(|>\(/.test(bare)) return true
  let rest = bare
  for (const re of HARMLESS_REDIRECT) rest = rest.replace(re, ' ')
  return rest.includes('>')
}

export function splitShell(cmd: string): Segment[] {
  const out: Segment[] = []
  let cur = '', bare = '', quote = '', opaque = false // bare = 只含引号外的字符，用来判断结构
  const flush = (force = false) => {
    const text = cur.trim()
    if (text) out.push({ text, opaque: force || opaque || isOpaque(bare.trim()) })
    cur = ''; bare = ''; opaque = false
  }

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!, n = cmd[i + 1]
    // 命令替换在双引号里也会展开，只有单引号里不会。
    if (quote !== "'" && (c === '`' || (c === '$' && n === '('))) opaque = true
    if (c === '\\' && quote !== "'") {
      if (n === '\n') { i++; continue } // 续行：同一条命令
      cur += c + (n ?? ''); if (!quote) bare += ' '
      i++; continue
    }
    if (quote) { cur += c; if (c === quote) quote = ''; continue }
    if (c === "'" || c === '"') { quote = c; cur += c; bare += ' '; continue }

    if (c === ';' || c === '\n' || c === '|') { flush(); continue }
    if (c === '&') {
      if (cmd[i - 1] === '>' || n === '>') { cur += c; bare += c; continue } // `2>&1`、`&>file` 里的 & 是重定向
      flush(); continue
    }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) { // 注释到行尾
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++
      continue
    }
    cur += c; bare += c
  }
  flush(quote !== '') // 引号没闭合：这一段后面是什么没法判断
  return out
}
