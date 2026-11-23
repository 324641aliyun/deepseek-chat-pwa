import { nativeGetDataUrl, nativeGetText } from './native.js'

/**
 * B 站视频取样：不下载整段视频，直接用播放器用的「视频快照」雪碧图（videoshot）。
 * 一张雪碧图是 10×10 的网格，每格就是某个时间点的画面（480×270）；比解码 DASH 省得多，
 * 也不需要 FFmpeg。只能在 App 内使用：接口与图片都要绕过浏览器的跨域限制。
 *
 * 接口语义（2026-11 实测）：`index[i]` 是第 i 格的**时间点（秒）**，
 * `image` 是若干张雪碧图，按顺序每张装 img_x_len*img_y_len 格。
 */

const PAGE = 'https://www.bilibili.com/'
const headers = { referer: PAGE, origin: PAGE }

export type BilibiliFrame = {
  /** 全视频的帧序号，从 0 开始 */
  index: number
  /** 画面时间点（秒） */
  at: number
  /** JPEG 原件，用于上传给模型 */
  blob: Blob
  /** 缩略图 data URL，用于界面展示 */
  preview: string
}

export type BilibiliFrames = {
  bvid: string
  title: string
  /** 视频总时长（秒），未知时为 null */
  duration: number | null
  /** 视频里一共取到多少帧 */
  totalFrames: number
  /** 下一批的起点；null 表示已到末尾 */
  nextFrame: number | null
  frames: BilibiliFrame[]
}

type ShotData = {
  img_x_len: number
  img_y_len: number
  img_x_size: number
  img_y_size: number
  image: string[]
  index: number[]
}

type ViewData = {
  bvid: string
  title: string
  cid: number
  duration: number
  pages?: { cid: number; page: number; part: string; duration: number }[]
}

/** b23.tv 短链、URL、纯 BV 号都支持；BV 号是 12 位 */
const parseBvid = (value: string): string | undefined => value.match(/BV[0-9A-Za-z]{10}/)?.[0]

const absolute = (url: string): string => (url.startsWith('//') ? `https:${url}` : url)

/** 风控（412）时补一个 buvid cookie 再试一次；拿不到就按原错误抛出 */
let buvidCookie: string | null = null

const refreshBuvid = async (): Promise<string | null> => {
  try {
    const response = await nativeGetText('https://api.bilibili.com/x/frontend/finger/spi', headers)
    const body = JSON.parse(response.body) as { code?: number; data?: { b_3?: string; b_4?: string } }
    if (body.code === 0 && body.data?.b_3) {
      buvidCookie = `buvid3=${body.data.b_3}${body.data.b_4 ? `; buvid4=${body.data.b_4}` : ''}`
      return buvidCookie
    }
  } catch {
    // 取不到就保持无 cookie
  }
  return null
}

const readJson = async <T>(url: string): Promise<T> => {
  const send = async (): Promise<Awaited<ReturnType<typeof nativeGetText>>> => {
    const extra: Record<string, string> = buvidCookie ? { cookie: buvidCookie } : {}
    return nativeGetText(url, { ...headers, ...extra })
  }
  let response = await send()
  let body: { code?: number; message?: string; data?: T } | null = null
  try {
    body = JSON.parse(response.body)
  } catch {
    throw new Error(`B 站接口返回的不是 JSON：${response.body.slice(0, 120)}`)
  }
  // -412 / -352 是风控，补一次 buvid 再重试
  if (body?.code !== 0 && (body?.code === -412 || body?.code === -352 || response.status === 412)) {
    const cookie = await refreshBuvid()
    if (cookie) {
      response = await send()
      try {
        body = JSON.parse(response.body)
      } catch {
        body = null
      }
    }
  }
  if (!body || body.code !== 0) {
    throw new Error(`B 站接口报错：${body?.message ?? `code ${body?.code ?? response.status}`}`)
  }
  return body.data as T
}

/** 解析 BV 号与分 P：支持 BV 号、完整链接、b23.tv 短链 */
const resolveTarget = async (input: string): Promise<{ bvid: string; page: number }> => {
  const text = input.trim()
  const page = Number(text.match(/[?&]p=(\d+)/)?.[1] ?? 1)
  const direct = parseBvid(text)
  if (direct) {
    return { bvid: direct, page }
  }
  if (!/b23\.tv|bilibili\.com/i.test(text)) {
    throw new Error('请给出 BV 号、视频链接或 b23.tv 短链')
  }
  const response = await nativeGetText(text, headers)
  const bvid = parseBvid(response.url) ?? parseBvid(response.body)
  if (!bvid) {
    throw new Error('短链没有跳转到视频页，可能已失效')
  }
  return { bvid, page }
}

const loadImage = async (dataUrl: string): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const blob = await (await fetch(dataUrl)).blob()
      return await createImageBitmap(blob)
    } catch {
      // 老 WebView 上 createImageBitmap 可能不支持 JPEG，退回 <img>
    }
  }
  const image = new Image()
  image.decoding = 'async'
  image.src = dataUrl
  await image.decode()
  return image
}

type Cell = { x: number; y: number; width: number; height: number }

/** 画布裁剪。优先 OffscreenCanvas；老 WebView 退回普通 canvas + toBlob。 */
const crop = async (
  source: ImageBitmap | HTMLImageElement,
  cell: Cell,
  type: string,
  quality: number
): Promise<Blob> => {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(cell.width, cell.height)
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('无法创建画布')
    }
    context.drawImage(source, cell.x, cell.y, cell.width, cell.height, 0, 0, cell.width, cell.height)
    return canvas.convertToBlob({ type, quality })
  }
  const canvas = document.createElement('canvas')
  canvas.width = cell.width
  canvas.height = cell.height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('无法创建画布')
  }
  context.drawImage(source, cell.x, cell.y, cell.width, cell.height, 0, 0, cell.width, cell.height)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('画面编码失败'))),
      type,
      quality
    )
  })
}

const makeThumb = async (sheetImage: ImageBitmap | HTMLImageElement, cell: Cell): Promise<string> => {
  const scale = 240 / cell.width
  const thumbCanvas = document.createElement('canvas')
  thumbCanvas.width = 240
  thumbCanvas.height = Math.max(1, Math.round(cell.height * scale))
  const context = thumbCanvas.getContext('2d')
  if (!context) {
    return ''
  }
  context.drawImage(
    sheetImage,
    cell.x,
    cell.y,
    cell.width,
    cell.height,
    0,
    0,
    thumbCanvas.width,
    thumbCanvas.height
  )
  return thumbCanvas.toDataURL('image/jpeg', 0.6)
}

/**
 * 时间点换算：正常情况下 index 就是秒；若接口改成给帧号（数值远大于时长），
 * 用「最大值 / 时长」估一个帧率再换算，避免把帧号当秒显示。
 */
const toSeconds = (values: number[], duration: number | null): { at: (i: number) => number; frames: boolean } => {
  if (!values.length || !duration || duration <= 0) {
    return { at: (i) => values[i] ?? 0, frames: false }
  }
  const max = Math.max(...values)
  if (max <= duration * 1.5) {
    return { at: (i) => values[i] ?? 0, frames: false }
  }
  const fps = Math.max(1, Math.round(max / duration))
  return { at: (i) => Math.round(((values[i] ?? 0) / fps) * 10) / 10, frames: true }
}

/** 取一批画面：默认从第 0 帧起 12 张，一次最多 16 张 */
export const readBilibiliFrames = async (
  input: string,
  startFrame = 0,
  count = 12
): Promise<BilibiliFrames> => {
  const { bvid, page } = await resolveTarget(input)
  const view = await readJson<ViewData>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
  )
  const pageInfo = view.pages?.[Math.max(0, page - 1)]
  if (page > 1 && !pageInfo) {
    throw new Error(`这个视频没有第 ${page} 个分 P`)
  }
  const cid = pageInfo?.cid ?? view.cid
  const duration = pageInfo?.duration ?? view.duration ?? null
  const title =
    pageInfo && pageInfo.page > 1 ? `${view.title}（P${pageInfo.page} ${pageInfo.part}）` : view.title

  const shot = await readJson<ShotData>(
    `https://api.bilibili.com/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&cid=${cid}&index=1`
  )
  if (!shot?.image?.length || !shot.index?.length) {
    throw new Error('这个视频没有可用的画面快照（直播、付费或已下架的视频通常没有）')
  }

  const perSheet = Math.max(1, shot.img_x_len * shot.img_y_len)
  const totalFrames = shot.index.length
  const from = Math.max(0, Math.min(Math.floor(Number.isFinite(startFrame) ? startFrame : 0), totalFrames - 1))
  const to = Math.min(totalFrames, from + Math.max(1, Math.min(Number(count) || 12, 16)))
  const time = toSeconds(shot.index, duration)

  const sheets = new Map<number, ImageBitmap | HTMLImageElement>()
  const frames: BilibiliFrame[] = []
  for (let index = from; index < to; index++) {
    const sheetIndex = Math.floor(index / perSheet)
    const url = shot.image[sheetIndex]
    if (!url) {
      break
    }
    let sheetImage = sheets.get(sheetIndex)
    if (!sheetImage) {
      sheetImage = await loadImage(await nativeGetDataUrl(absolute(url), headers))
      sheets.set(sheetIndex, sheetImage)
    }
    const cellIndex = index % perSheet
    const row = Math.floor(cellIndex / shot.img_x_len)
    const column = cellIndex % shot.img_x_len
    const cell: Cell = {
      x: column * shot.img_x_size,
      y: row * shot.img_y_size,
      width: shot.img_x_size,
      height: shot.img_y_size,
    }
    const blob = await crop(sheetImage, cell, 'image/jpeg', 0.85)
    frames.push({
      index,
      at: time.at(index),
      blob,
      preview: await makeThumb(sheetImage, cell),
    })
  }
  if (frames.length === 0) {
    throw new Error('没有取到画面，可能已到视频末尾')
  }

  return {
    bvid,
    title,
    duration,
    totalFrames,
    nextFrame: to < totalFrames ? to : null,
    frames,
  }
}
