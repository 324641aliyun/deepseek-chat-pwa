import { CapacitorHttp } from '@capacitor/core'

/**
 * App 内的原生网络。浏览器的 fetch 受同源策略限制，拿不到 B 站接口和大多数网页正文；
 * 装成 App 之后走 WebView 底层的原生请求，没有跨域限制，也能自带 Referer。
 * 只有在 Capacitor 容器里才可用，普通浏览器里这些函数不会被调用。
 */

type NativeWindow = Window & { Capacitor?: { isNativePlatform?: () => boolean } }

export const isNativeApp = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  const capacitor = (window as NativeWindow).Capacitor
  return typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()
}

const TIMEOUT = { connectTimeout: 15_000, readTimeout: 30_000 }

export type NativeResponse = {
  status: number
  /** 跟随重定向后的最终地址（b23.tv 短链要靠它拿到 BV 号） */
  url: string
  contentType: string
  body: string
}

const readText = async (url: string, headers: Record<string, string>): Promise<NativeResponse> => {
  const response = await CapacitorHttp.request({
    url,
    method: 'GET',
    headers,
    responseType: 'text',
    ...TIMEOUT,
  })
  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '')
  return {
    status: response.status,
    url: response.url ?? url,
    contentType: String(response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? ''),
    body: raw,
  }
}

/** 抓文本；非 2xx 直接抛错，调用方只处理成功路径 */
export const nativeGetText = async (
  url: string,
  headers: Record<string, string> = {}
): Promise<NativeResponse> => {
  const response = await readText(url, {
    'user-agent':
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`请求失败（${response.status}）：${url}`)
  }
  return response
}

/** 抓二进制并转成 data URL；Android 上 arraybuffer 回来的是 base64 */
export const nativeGetDataUrl = async (
  url: string,
  headers: Record<string, string> = {}
): Promise<string> => {
  const response = await CapacitorHttp.request({
    url,
    method: 'GET',
    headers,
    responseType: 'arraybuffer',
    ...TIMEOUT,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`下载失败（${response.status}）：${url}`)
  }
  const data = response.data
  if (typeof data !== 'string') {
    throw new Error('原生请求没有返回二进制内容')
  }
  const contentType = String(
    response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? 'image/jpeg'
  )
  return data.startsWith('data:') ? data : `data:${contentType};base64,${data}`
}
