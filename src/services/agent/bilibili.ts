import { nativeGetDataUrl, nativeGetText } from './native.js'

/**
 * B 站视频取样：不下载整段视频，直接用播放器用的「视频快照」雪碧图（videoshot）取画面。
 * 一张图是 10×10 的网格，每格就是某个时间点的画面，480×270；比解码 DASH 省得多，也不需要 FFmpeg。
 * 只能在 App 内使用：接口和图片都要带 Referer，浏览器里会被跨域拦掉。
 */

const REFERER = { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' }

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

const parseBvid = (value: string): string | undefined => value.match(/BV[0-9A-Za-z]{10}/)?.[0]

const absolute = (url: string): string => (url.startsWith('//') ? `https:${url}` : url)

const readJson = async <T>(url: string): Promise<T> => {
  const response = await nativeGetText(url, REFERER)
  let body: { code?: number; message?: string; data?: T }
  try {
    body = JSON.parse(response.body)
  } catch {
    throw new Error(`接口返回的不是 JSON：${response.body.slice(0, 120)}`)
  }
  if (body.code !== 0) {
    throw new Error(`B 站接口报错：${body.message ?? `code ${body.code}`}`)
  }
  return body.data as T
}

type ViewData = {
  bvid: string
  title: string
  cid: number
  duration: number
  pages?: { cid: number; page: number; part: string }[]
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
  const response = await nativeGetText(text, REFERER)
  const bvid = parseBvid(response.url) ?? parseBvid(response.body)
  if (!bvid) {
    throw new Error('短链没有跳转到视频页，可能已失效')
  }
  return { bvid, page }
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('缩略图转换失败'))
    reader.readAsDataURL(blob)
  })

const decodeImage = async (dataUrl: string): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === 'function') {
    const blob = await (await fetch(dataUrl)).blob()
    return createImageBitmap(blob)
  }
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  return image
}

const cropFrame = async (
  source: ImageBitmap | HTMLImageElement,
  cell: { x: number; y: number; width: number; height: number }
): Promise<{ blob: Blob; preview: string }> => {
  const width = cell.width
  const height = cell.height
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('无法创建画布')
  }
  context.drawImage(source, cell.x, cell.y, width, height, 0, 0, width, height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })

  // 缩略图：宽度固定 240，够看清画面又不至于把会话撑大
  const scale = 240 / width
  const thumbCanvas = new OffscreenCanvas(240, Math.round(height * scale))
  const thumbContext = thumbCanvas.getContext('2d')
  if (!thumbContext) {
    throw new Error('无法创建缩略图画布')
  }
  thumbContext.drawImage(source, cell.x, cell.y, width, height, 0, 0, 240, Math.round(height * scale))
  const thumb = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 })
  return { blob, preview: await blobToDataUrl(thumb) }
}

/** 取一批画面：默认从第 0 帧起 12 张，页面大小受雪碧图网格限制 */
export const readBilibiliFrames = async (
  input: string,
  startFrame = 0,
  count = 12
): Promise<BilibiliFrames> => {
  const { bvid, page } = await resolveTarget(input)
  const view = await readJson<ViewData>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
  )
  const pageInfo = view.pages?.[page - 1]
  const cid = pageInfo?.cid ?? view.cid
  const title = pageInfo && pageInfo.page > 1 ? `${view.title}（P${pageInfo.page} ${pageInfo.part}）` : view.title

  const shot = await readJson<ShotData>(
    `https://api.bilibili.com/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&cid=${cid}&index=1`
  )
  if (!shot?.image?.length || !shot.index?.length) {
    throw new Error('这个视频没有可用的画面快照（可能是直播、付费或已下架）')
  }

  const totalFrames = shot.index.length
  const perSheet = shot.img_x_len * shot.img_y_len
  const from = Math.max(0, Math.min(Math.floor(startFrame), totalFrames - 1))
  const to = Math.min(totalFrames, from + Math.max(1, Math.min(count, 24)))
  const sheets = new Map<number, ImageBitmap | HTMLImageElement>()
  const frames: BilibiliFrame[] = []

  for (let index = from; index < to; index++) {
    const sheetIndex = Math.floor(index / perSheet)
    let source = sheets.get(sheetIndex)
    if (!source) {
      const url = absolute(shot.image[sheetIndex] ?? shot.image[0])
      source = await decodeImage(await nativeGetDataUrl(url, REFERER))
      sheets.set(sheetIndex, source)
    }
    const cellIndexOnSheet = index % perSheet
    const row = Math.floor(cellIndexOnSheet / shot.img_x_len)
    const column = cellIndexOnSheet % shot.img_x_len
    const { blob, preview } = await cropFrame(source, {
      x: column * shot.img_x_size,
      y: row * shot.img_y_size,
      width: shot.img_x_size,
      height: shot.img_y_size,
    })
    frames.push({ index, at: shot.index[index] ?? 0, blob, preview })
  }

  return {
    bvid,
    title,
    totalFrames,
    nextFrame: to < totalFrames ? to : null,
    frames,
  }
}
