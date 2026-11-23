import { CapacitorHttp } from '@capacitor/core'

/**
 * App 内的原生网络。浏览器的 fetch 受同源策略限制，拿不到 B 站接口和大多数网页正文；
 * 装成 App 之后请求走 WebView 底层的原生 HTTP，没有跨域限制，也能自带 Referer。
 * 只有在 Capacitor 容器里才可用；浏览器里这些函数不会被调用（isNativeApp 为 false）。
 *
 * 注意：必须在外壳配置里打开 CapacitorHttp 插件，否则请求会落回浏览器 fetch 并被 CORS 拦掉。
 */

type NativeWindow = Window & { Capacitor?: { isNativePlatform?: () => boolean } }

export const isNativeApp = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  const capacitor = (window as NativeWindow).Capacitor
  return typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()
}

const TIMEOUT = { connectTimeout: 15_000, readTimeout: 40_000 }

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

export type NativeResponse = {
  status: number
  /** 跟随重定向后的最终地址（b23.tv 短链要靠它拿到 BV 号） */
  url: string
  contentType: string
  body: string
}

/** 原生层返回的 header 名大小写不统一，这里做一次大小写无关的查找 */
const readHeader = (headers: unknown, name: string): string => {
  if (!headers || typeof headers !== 'object') {
    return ''
  }
  const record = headers as Record<string, unknown>
  const hit = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase())
  return hit ? String(record[hit] ?? '') : ''
}

const toText = (data: unknown): string => {
  if (typeof data === 'string') {
    return data
  }
  if (data === null || data === undefined) {
    return ''
  }
  // Android 侧遇到 JSON 响应会直接解析成对象，序列化回文本即可
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

const requestText = async (
  url: string,
  headers: Record<string, string>,
  mobile: boolean
): Promise<NativeResponse> => {
  const response = await CapacitorHttp.request({
    url,
    method: 'GET',
    headers: {
      'user-agent': mobile ? MOBILE_UA : DESKTOP_UA,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
      ...headers,
    },
    responseType: 'text',
    ...TIMEOUT,
  })
  return {
    status: response.status,
    url: typeof response.url === 'string' && response.url ? response.url : url,
    contentType: readHeader(response.headers, 'content-type'),
    body: toText(response.data),
  }
}

/** 抓文本；非 2xx 抛错，并把状态码带上，调用方据此决定是否重试 */
export const nativeGetText = async (
  url: string,
  headers: Record<string, string> = {},
  options: { mobile?: boolean } = {}
): Promise<NativeResponse> => {
  const response = await requestText(url, headers, options.mobile !== false)
  if (response.status < 200 || response.status >= 300) {
    const detail = response.body.slice(0, 160).replace(/\s+/g, ' ')
    throw new Error(`请求失败（${response.status}）：${detail || url}`)
  }
  return response
}

/**
 * 抓二进制并转成 data URL。
 * Android 的 CapacitorHttp 对 arraybuffer 返回 base64 字符串；其他平台可能直接给 ArrayBuffer。
 */
export const nativeGetDataUrl = async (
  url: string,
  headers: Record<string, string> = {}
): Promise<string> => {
  const response = await CapacitorHttp.request({
    url,
    method: 'GET',
    headers: { 'user-agent': MOBILE_UA, ...headers },
    responseType: 'arraybuffer',
    ...TIMEOUT,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`下载失败（${response.status}）：${url}`)
  }
  const contentType = readHeader(response.headers, 'content-type') || 'image/jpeg'
  const data = response.data
  if (typeof data === 'string') {
    return data.startsWith('data:') ? data : `data:${contentType};base64,${data}`
  }
  if (data instanceof ArrayBuffer) {
    let binary = ''
    const bytes = new Uint8Array(data)
    for (let index = 0; index < bytes.length; index++) {
      binary += String.fromCharCode(bytes[index])
    }
    return `data:${contentType};base64,${btoa(binary)}`
  }
  throw new Error('原生请求没有返回可用的二进制内容')
}
