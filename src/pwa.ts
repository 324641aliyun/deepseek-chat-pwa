/**
 * 注册 Service Worker，让站点可以安装到主屏幕并离线打开外壳。
 *
 * 生产环境判断使用构建时注入的 __PWA_ENABLED__（见 rspack.config.ts 的 DefinePlugin）：
 * rspack 默认不注入 import.meta.env，而浏览器里的 process.env.NODE_ENV 只是自由变量，
 * 两者都不可靠；由构建配置显式注入布尔值最稳妥。
 *
 * 运行时再兜底跳过 file: 和 localhost 系列地址，避免本地预览注册出旧缓存。
 */

/** 构建时注入：生产构建为 true，开发服务器为 false；未注入时按可用处理 */
const pwaEnabled: boolean = typeof __PWA_ENABLED__ === 'undefined' ? true : __PWA_ENABLED__

/** 本地开发 / 预览地址不注册 Service Worker，避免旧缓存干扰调试 */
const isLocalDevelopment = (): boolean => {
  if (window.location.protocol === 'file:') {
    return true
  }
  const { hostname } = window.location
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

const start = async (): Promise<void> => {
  try {
    // 用 document.baseURI 解析：部署到 /repo/ 子路径时得到 /repo/sw.js
    await navigator.serviceWorker.register(new URL('sw.js', document.baseURI))
  } catch (error) {
    // 注册失败不能影响页面本身，只留下告警
    // eslint-disable-next-line no-console
    console.warn('[pwa] Service Worker 注册失败', error)
  }
}

/** 在满足条件时注册离线外壳的 Service Worker */
export function registerPwa(): void {
  if (!pwaEnabled) {
    return
  }
  if (!('serviceWorker' in navigator)) {
    return
  }
  if (!/^https?:$/.test(window.location.protocol)) {
    return
  }
  if (isLocalDevelopment()) {
    return
  }
  // 等首屏加载完成再注册，避免和首屏资源抢带宽
  if (document.readyState === 'complete') {
    void start()
    return
  }
  window.addEventListener('load', () => void start(), { once: true })
}
