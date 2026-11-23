/**
 * DeepSeek 对话 —— 离线外壳 Service Worker
 *
 * 只做两件事：
 * 1. 安装时预缓存应用外壳（HTML、manifest、图标、LICENSE 和构建产物）；
 * 2. 同源静态资源 cache-first + 后台更新，导航 network-first 并回退到缓存的 index.html。
 *
 * API 请求（/anthropic/、/responses、/chat/completions、/models、/files）
 * 一律不拦截、不缓存，直接走网络。
 *
 * 所有地址都以当前 scope 为基准解析，部署到 GitHub Pages 子路径（/repo/）也能正常工作。
 */

// Service Worker 里的告警是排查缓存安装问题的唯一线索，保留控制台输出
/* eslint-disable no-console */

/** 缓存版本：改动预缓存清单或策略时递增；activate 会清理同前缀的旧缓存 */
const CACHE_VERSION = 'v1'

/** 缓存名前缀，只清理自己的缓存，避免误删同源其它站点的缓存 */
const CACHE_PREFIX = 'deepseek-shell-'

const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`

/** 当前 Service Worker 的作用域，例如 https://user.github.io/repo/ */
const SCOPE = self.registration.scope

/** 把相对的 scope 内路径解析成绝对地址，不写死站点根路径 */
const scopeUrl = (path) => new URL(path, SCOPE).href

/** 安装时预缓存的应用外壳 */
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './LICENSE',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
].map(scopeUrl)

/** 这些路径属于模型 / 文件 API，不缓存也不回退 */
const API_PATH_MARKERS = ['/anthropic/', '/responses', '/chat/completions', '/models', '/files']

/** 可走缓存优先的同源静态资源类型 */
const STATIC_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'manifest'])

/** 判断是否为 API 请求（跨域、同源都按路径判断） */
const isApiRequest = (url) => API_PATH_MARKERS.some((marker) => url.pathname.includes(marker))

/**
 * 解析已缓存的外壳 HTML，把其中引用的同源脚本、样式等一起缓存。
 * 这样首次安装完成后就能完全离线打开页面，而不只是拿到一个空 HTML。
 */
const warmShellAssets = async (cache) => {
  try {
    const shell =
      (await cache.match(scopeUrl('./index.html'))) ?? (await cache.match(scopeUrl('./')))
    if (!shell) {
      return
    }
    const html = await shell.text()
    const urls = new Set()
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const asset = new URL(match[1], scopeUrl('./'))
      if (asset.origin !== self.location.origin) {
        continue
      }
      if (!/\.(?:js|css|woff2?|ttf|png|svg|webp)$/i.test(asset.pathname)) {
        continue
      }
      urls.add(asset.href)
    }
    await Promise.all(
      [...urls].map(async (url) => {
        try {
          await cache.add(url)
        } catch {
          // 单个构建产物缺失不影响外壳安装
        }
      })
    )
  } catch {
    // 预热只是优化，失败时保持已缓存的外壳即可
  }
}

/** 安装：预缓存外壳，并跳过等待尽快接管页面 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // 逐条写入：单个文件 404 不应该让整个安装失败
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            await cache.add(url)
          } catch (error) {
            console.warn('[sw] 预缓存失败', url, error)
          }
        })
      )
      await warmShellAssets(cache)
    })()
  )
  self.skipWaiting()
})

/** 激活：清理旧版本缓存，并立即接管已有页面 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
      await self.clients.claim()
    })()
  )
})

/** 导航请求：network-first，失败回退缓存的 index.html */
const networkFirstNavigation = async (request) => {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    // 顺便更新离线外壳，保证下次离线打开的是最新版本
    if (response.ok && !response.redirected) {
      try {
        await cache.put(scopeUrl('./index.html'), response.clone())
      } catch {
        // 写入失败不影响本次导航
      }
    }
    return response
  } catch {
    const shell =
      (await cache.match(scopeUrl('./index.html'))) ?? (await cache.match(scopeUrl('./')))
    return shell ?? Response.error()
  }
}

/** 同源静态资源：cache-first + 后台更新 */
const cacheFirst = async (event) => {
  const { request } = event
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  const revalidate = fetch(request).then(async (response) => {
    // 只缓存成功响应，避免把错误页写进缓存
    if (response.ok) {
      try {
        await cache.put(request, response.clone())
      } catch {
        // 配额不足等情况忽略，读取不受影响
      }
    }
    return response
  })

  if (cached) {
    // 先返回缓存，后台静默更新；waitUntil 保证更新不会被提前中断
    event.waitUntil(revalidate.catch(() => undefined))
    return cached
  }

  try {
    return await revalidate
  } catch {
    return Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  // 非 GET 请求（对话、上传等）不经过缓存
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  // 模型与文件 API 一律直接走网络，不缓存也不回退
  if (isApiRequest(url)) {
    return
  }
  // 跨域资源交给浏览器按默认策略处理
  if (url.origin !== self.location.origin) {
    return
  }
  // 导航请求：network-first，离线回退外壳
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }
  // 同源静态资源：cache-first + 后台更新
  if (STATIC_DESTINATIONS.has(request.destination)) {
    event.respondWith(cacheFirst(event))
  }
})
