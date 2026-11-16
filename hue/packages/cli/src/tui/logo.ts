/**
 * 色环 logo：用四分之一方块字符（▘▝▖▗▀▌▞▛…）拼的像素风圆环，所有终端都一样，不依赖图片协议。
 * 一格是 2×2 个"像素"，每格只能有一种前景色，所以 site/ 里的 13 段渐变合并成 5 个色块（五色各占 72°）。
 * 之前试过 Kitty 图片协议版（真 SVG）和盲文版：前者只有部分终端能用，后者曲线更细但有点糊，见 DECISIONS 10。
 */
import { rgbFg } from './theme.js'

// site/ 的 --c1..--c5，从正上方顺时针。
const BLOCKS = [[0xff, 0x6a, 0x1a], [0xf5, 0xb7, 0x00], [0x5c, 0xcf, 0x5a], [0x19, 0xc3, 0xbd], [0x3a, 0x9f, 0xff]] as const

// 位：左上 1、右上 2、左下 4、右下 8。
const GLYPH = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']
const QUAD = [1, 2, 4, 8]

/**
 * 画 `cols`×`rows` 格的圆环（外径 = 一半宽度，孔径 `hole` 同单位）。
 * 字符格大约是 1:2，所以一个象限在物理上是 0.5×1：横向 cols 格 = cols 个单位，纵向 rows 格 = rows×2 个单位，
 * 6×3 时正好是正圆。
 */
export function ring(cols: number, rows: number, hole = 1.4): string[] {
  const cx = cols / 2, cy = rows
  const outer = Math.min(cols, rows * 2) / 2
  const S = 4
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      let bits = 0
      for (let q = 0; q < 4; q++) {
        const qx = q % 2, qy = q >> 1
        let on = 0
        for (let sx = 0; sx < S; sx++) {
          for (let sy = 0; sy < S; sy++) {
            const d = Math.hypot(c + (qx + (sx + 0.5) / S) / 2 - cx, r * 2 + qy + (sy + 0.5) / S - cy)
            if (d >= hole && d <= outer) on++
          }
        }
        if (on * 2 >= S * S) bits |= QUAD[q]!
      }
      if (!bits) { line += ' '; continue }
      // 顺时针、从正上方开始，按格子中心的角度挑色块
      const t = (Math.atan2(c + 0.5 - cx, -(r * 2 + 1 - cy)) / (2 * Math.PI) + 1) % 1
      const [R, G, B] = BLOCKS[Math.floor(t * BLOCKS.length)]!
      line += rgbFg(R, G, B)(GLYPH[bits]!)
    }
    out.push(line)
  }
  return out
}
