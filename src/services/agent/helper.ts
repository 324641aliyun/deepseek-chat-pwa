/**
 * 可选的本地工具服务：在电脑上跑一个小服务，提供网页正文抓取与 B 站视频取样。
 * 手机端不配置它也能正常聊天，只是这两个工具不出现在工具列表里。
 */

export type HelperState = {
  /** 服务基地址，例如 http://192.168.1.13:8787；未配置为 null */
  baseUrl: string | null
}

const TIMEOUT_MS = 45_000

/** 去掉末尾斜杠，避免拼出双斜杠路径 */
export const normalizeHelperUrl = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  return trimmed.replace(/\/+$/, '')
}

/** 组合外部取消与本地超时；不依赖较新的 AbortSignal.any，兼容旧版 Chrome */
const withTimeout = (signal: AbortSignal, extraMs: number): AbortSignal => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('本地服务响应超时')), extraMs)
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) {
    forward()
  } else {
    signal.addEventListener('abort', forward, { once: true })
  }
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    },
    { once: true }
  )
  return controller.signal
}

export type FetchResult = { url: string; title: string; text: string; truncated: boolean }

/** 抓取网页正文：由本地服务完成，避开浏览器的跨域限制 */
export const fetchPage = async (
  baseUrl: string,
  url: string,
  signal: AbortSignal
): Promise<FetchResult> => {
  const response = await fetch(`${baseUrl}/fetch?url=${encodeURIComponent(url)}`, {
    signal: withTimeout(signal, TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`本地服务返回 ${response.status}：${(await response.text()).slice(0, 200)}`)
  }
  const body: unknown = await response.json()
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as FetchResult).text !== 'string' ||
    typeof (body as FetchResult).url !== 'string'
  ) {
    throw new Error('本地服务返回的内容不是预期的网页正文格式')
  }
  const result = body as FetchResult
  return {
    url: result.url,
    title: typeof result.title === 'string' ? result.title : '',
    text: result.text,
    truncated: result.truncated === true,
  }
}

export type VideoFrame = { index: number; at: number; image: string }

export type VideoFrames = {
  bvid: string
  title: string
  /** 下一页起点；null 表示已到流尾 */
  nextFrame: number | null
  frames: VideoFrame[]
}

/** B 站视频取样：本地服务解码 DASH 流，返回一组帧（data URL） */
export const readVideoFrames = async (
  baseUrl: string,
  url: string,
  startFrame: number,
  signal: AbortSignal
): Promise<VideoFrames> => {
  const params = new URLSearchParams({ url, frame: String(startFrame) })
  const response = await fetch(`${baseUrl}/bilibili?${params.toString()}`, {
    signal: withTimeout(signal, TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`本地服务返回 ${response.status}：${(await response.text()).slice(0, 200)}`)
  }
  return (await response.json()) as VideoFrames
}

/** 探测服务是否在线；离线时把工具从列表里去掉，避免模型调用到一半才发现不可用 */
export const probeHelper = async (baseUrl: string, signal: AbortSignal): Promise<boolean> => {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: withTimeout(signal, 4000) })
    return response.ok
  } catch {
    return false
  }
}
