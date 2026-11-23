/**
 * 生成 PWA 图标：品牌蓝圆角方块 + 白色对话气泡，纯代码绘制。
 * 只使用 Node 内置模块（zlib），不引入任何依赖。
 *
 * 用法：node tools/make-icons.mjs
 */
// 命令行脚本需要输出生成进度
/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconsDir = join(root, 'public', 'icons')

/** 品牌色 #4D6BFE */
const BRAND = [0x4d, 0x6b, 0xfe]
const WHITE = [255, 255, 255]

/** maskable 图标的内容安全区半径（相对边长）：图形必须落在中心 80% 的圆内 */
const MASKABLE_SAFE_RADIUS = 0.4

/** 抗锯齿用的超采样倍数（每轴 4 个采样点） */
const SAMPLES = 4

// ---------- PNG 编码 ----------

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** 计算 PNG 分块的 CRC32 */
const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 组装一个 PNG 分块：长度 + 类型 + 数据 + CRC */
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 把 RGBA 像素编码为 8 位真彩 PNG（颜色类型 6） */
const encodePng = (width, height, rgba) => {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    // 每行首字节是过滤类型，0 表示不过滤
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：真彩 + alpha
  ihdr[10] = 0 // 压缩方式
  ihdr[11] = 0 // 过滤方式
  ihdr[12] = 0 // 隔行扫描
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 形状 ----------

/** 圆角矩形覆盖测试，坐标与半径都相对同一个归一化盒子 */
const inRoundedRect = (u, v, { x0, y0, x1, y1, r }) => {
  if (u < x0 || u > x1 || v < y0 || v > y1) {
    return false
  }
  // 把点夹到内部矩形，到夹取点的距离不超过圆角半径即视为在形状内
  const cx = Math.min(Math.max(u, x0 + r), x1 - r)
  const cy = Math.min(Math.max(v, y0 + r), y1 - r)
  const dx = u - cx
  const dy = v - cy
  return dx * dx + dy * dy <= r * r
}

/** 三角形覆盖测试，两种绕向都适用 */
const inTriangle = (u, v, a, b, c) => {
  const d1 = (u - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (v - b[1])
  const d2 = (u - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (v - c[1])
  const d3 = (u - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (v - a[1])
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNegative && hasPositive)
}

/** 气泡本体：略带圆角的矩形 */
const BUBBLE_BODY = { x0: 0.02, y0: 0.04, x1: 0.98, y1: 0.72, r: 0.18 }
/** 气泡尾巴：左下角向下的三角，与本体并集成对话气泡 */
const BUBBLE_TAIL = [
  [0.2, 0.58],
  [0.22, 0.98],
  [0.52, 0.72],
]

/** 图标底：rounded 为圆角方块（透明四角），full 为满幅不透明方块 */
const makeBackground = (kind) => {
  if (kind === 'full') {
    return () => true
  }
  const radius = 0.22
  return (u, v) => inRoundedRect(u, v, { x0: 0, y0: 0, x1: 1, y1: 1, r: radius })
}

// ---------- 渲染 ----------

/**
 * 渲染一张图标。
 * 逐像素做 4×4 超采样，按覆盖比例合成直通 alpha 的 RGBA。
 * @param {number} size 边长（像素）
 * @param {{ background: 'rounded' | 'full', bubbleScale: number }} options
 */
const renderIcon = (size, { background, bubbleScale }) => {
  const rgba = Buffer.alloc(size * size * 4)
  const backgroundTest = makeBackground(background)
  const totalSamples = SAMPLES * SAMPLES
  const half = bubbleScale / 2
  const bubbleOrigin = 0.5 - half
  let maxContentRadius = 0

  /** 归一化坐标是否落在气泡内 */
  const inBubble = (u, v) => {
    const bu = (u - bubbleOrigin) / bubbleScale
    const bv = (v - bubbleOrigin) / bubbleScale
    if (bu < 0 || bu > 1 || bv < 0 || bv > 1) {
      return false
    }
    return (
      inRoundedRect(bu, bv, BUBBLE_BODY) ||
      inTriangle(bu, bv, BUBBLE_TAIL[0], BUBBLE_TAIL[1], BUBBLE_TAIL[2])
    )
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let covered = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        const v = (y + (sy + 0.5) / SAMPLES) / size
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const u = (x + (sx + 0.5) / SAMPLES) / size
          if (!backgroundTest(u, v)) {
            continue
          }
          covered += 1
          if (inBubble(u, v)) {
            red += WHITE[0]
            green += WHITE[1]
            blue += WHITE[2]
            maxContentRadius = Math.max(maxContentRadius, Math.hypot(u - 0.5, v - 0.5))
          } else {
            red += BRAND[0]
            green += BRAND[1]
            blue += BRAND[2]
          }
        }
      }
      const offset = (y * size + x) * 4
      if (covered === 0) {
        // 透明像素保持全 0，避免出现彩色噪点
        continue
      }
      // 颜色只在被底色覆盖的采样点之间平均，得到干净的直通 alpha
      rgba[offset] = Math.round(red / covered)
      rgba[offset + 1] = Math.round(green / covered)
      rgba[offset + 2] = Math.round(blue / covered)
      rgba[offset + 3] = Math.round((covered / totalSamples) * 255)
    }
  }

  return { png: encodePng(size, size, rgba), maxContentRadius }
}

// ---------- 输出与自检 ----------

/** 回读生成的文件，确认 PNG 签名和 IHDR 尺寸正确 */
const verifyPng = (file, size) => {
  const buffer = readFileSync(file)
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${file} 不是合法 PNG（签名 ${signature}）`)
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width !== size || height !== size) {
    throw new Error(`${file} 尺寸 ${width}×${height} 与期望的 ${size}×${size} 不一致`)
  }
}

/** 需要生成的图标：文件名、边长、底色类型、气泡占比 */
const targets = [
  { name: 'icon-192.png', size: 192, background: 'rounded', bubbleScale: 0.6 },
  { name: 'icon-512.png', size: 512, background: 'rounded', bubbleScale: 0.6 },
  { name: 'icon-maskable-192.png', size: 192, background: 'full', bubbleScale: 0.52 },
  { name: 'icon-maskable-512.png', size: 512, background: 'full', bubbleScale: 0.52 },
  { name: 'apple-touch-icon-180.png', size: 180, background: 'full', bubbleScale: 0.6 },
]

mkdirSync(iconsDir, { recursive: true })

for (const target of targets) {
  const { png, maxContentRadius } = renderIcon(target.size, target)
  const file = join(iconsDir, target.name)
  writeFileSync(file, png)
  verifyPng(file, target.size)
  if (target.background === 'full') {
    const isMaskable = target.name.startsWith('icon-maskable')
    // 满幅图标只有 maskable 需要安全区检查，Apple 图标不参与裁剪
    if (isMaskable && maxContentRadius > MASKABLE_SAFE_RADIUS) {
      throw new Error(
        `${target.name} 的图形半径 ${maxContentRadius.toFixed(3)} 超出安全区 ${MASKABLE_SAFE_RADIUS}`
      )
    }
    const percent = (maxContentRadius / MASKABLE_SAFE_RADIUS) * 100
    console.log(
      `生成 ${target.name}  ${target.size}×${target.size}  ${png.length} 字节  图形半径 ${maxContentRadius.toFixed(3)}（安全区占用 ${percent.toFixed(1)}%）`
    )
  } else {
    console.log(
      `生成 ${target.name}  ${target.size}×${target.size}  ${png.length} 字节  图形半径 ${maxContentRadius.toFixed(3)}`
    )
  }
}

console.log(`图标已输出到 ${iconsDir}`)
