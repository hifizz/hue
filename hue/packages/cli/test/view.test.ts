import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { Banner, type BannerInfo } from '../src/tui/banner.js'
import { diffRows, Gutter, ToolView } from '../src/tui/view.js'

const info: BannerInfo = {
  version: '0.0.0',
  cwd: '~/acme-api (main)',
  hasTask: false,
  rows: [['模型', 'claude-sonnet-5-5', '1M'], ['沙箱', 'local', '当前目录']],
}
const plain = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))

test('横幅：每一行宽度一致，宽终端有右栏，窄终端只留左栏', () => {
  for (const width of [120, 60]) {
    const lines = new Banner(info).render(width)
    const box = lines.filter(l => l.trim())
    for (const l of box) assert.equal(visibleWidth(l), visibleWidth(box[0]!), `width ${width}`)
    assert.ok(visibleWidth(box[0]!) <= width)
  }
  assert.match(plain(new Banner(info).render(120)).join('\n'), /能做什么/)
  assert.doesNotMatch(plain(new Banner(info).render(60)).join('\n'), /能做什么/)
  assert.doesNotMatch(plain(new Banner(info).render(120)).join('\n'), /task/)
  assert.match(plain(new Banner({ ...info, hasTask: true }).render(120)).join('\n'), /task/)
})

test('Gutter：第一行带标记，续行缩进对齐', () => {
  const inner = { invalidate() {}, render: () => ['a', 'b'] }
  assert.deepEqual(new Gutter(' ● ', inner).render(20), [' ● a', '   b'])
})

test('edit 的 diff：先删后增，超过上限折叠', () => {
  const rows = diffRows('a\nb\nc', 'x', 2)
  const text = plain(rows.flatMap(r => r.render(20))).join('\n')
  assert.match(text, /− a/)
  assert.match(text, /\+ x/)
  assert.match(text, /还有 1 行/)
})

test('ToolView：标题、diff、结果各占自己的行', () => {
  const v = new ToolView()
  v.title = 'bash(ls)'
  v.status = 'ok'
  v.result = 'done'
  const lines = plain(v.render(40))
  assert.match(lines[0]!, /^ ● bash\(ls\)/)
  assert.match(lines[1]!, /^ {3}⎿ done/)
})
