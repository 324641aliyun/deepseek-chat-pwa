import type { CapacitorConfig } from '@capacitor/cli'

/**
 * App 外壳配置。
 *
 * - server.androidScheme: 页面跑在 https://localhost，localStorage / IndexedDB / 流式请求与浏览器一致。
 * - CapacitorHttp.enabled: 让 WebView 的请求走原生网络（没有跨域限制），B 站接口与网页抓取都依赖它；
 *   不开这个开关时，跨域请求会被 WebView 按 CORS 拦掉。
 * - SystemBars.insetsHandling: Android 15+ / HyperOS 强制全面屏（edge-to-edge）。
 *   css 模式会把状态栏、导航栏、挖孔的高度写进 --safe-area-inset-* 自定义属性，
 *   由页面自己留白；initialViewportFitValueHint 避免首帧跳动。
 */
const config: CapacitorConfig = {
  appId: 'com.aliyun.deepseekchat',
  appName: 'DeepSeek 对话',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#ffffff',
    // 输入框聚焦时不要缩放页面
    zoomEnabled: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
}

export default config
