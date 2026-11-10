export interface Doc { name: string; description: string; content: string; updated: string }

/** 英文按词，中日文按单字加相邻两字（没有空格可分词，只按词匹配搜不到）。 */
export function tokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of s.toLowerCase().matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}]+/gu)) {
    const w = m[0]
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w)) {
      const cs = [...w]
      for (let i = 0; i < cs.length; i++) { out.add(cs[i]!); if (i + 1 < cs.length) out.add(cs[i]! + cs[i + 1]!) }
    } else out.add(w)
  }
  return out
}

/**
 * 关键词打分：查询里的每个词，命中名字 3 分、描述 2 分、正文 1 分，求和；名字完全一致再加 100。
 * 没有向量，也没有 IDF——几百条以内的笔记够用，召回质量没有量过。分数相同新的在前。
 */
export function search(docs: Doc[], query: string, k: number): Doc[] {
  const q = tokens(query)
  const scored = docs.map(d => {
    const n = tokens(d.name.replace(/[-_]/g, ' ')), de = tokens(d.description), c = tokens(d.content)
    let score = d.name === query.trim() ? 100 : 0
    for (const t of q) score += (n.has(t) ? 3 : 0) + (de.has(t) ? 2 : 0) + (c.has(t) ? 1 : 0)
    return { d, score }
  })
  return scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.d.updated.localeCompare(a.d.updated) || a.d.name.localeCompare(b.d.name)).slice(0, k).map(x => x.d)
}
