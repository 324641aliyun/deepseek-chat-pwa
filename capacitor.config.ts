import type { CapacitorConfig } from '@capacitor/cli'

/**
 * App 外壳配置：网页资源打进 APK，WebView 以 https://localhost 提供页面，
 * 所以 localStorage / IndexedDB / 流式请求都和浏览器里一致。
 * 原生网络（CapacitorHttp）让 B 站接口与网页抓取绕过跨域限制。
 */
const config: CapacitorConfig = {
  appId: 'com.aliyun.deepseekchat',
  appName: 'DeepSeek 对话',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // 只加载本地打包资源，不连开发服务器
    allowMixedContent: false,
  },
}

export default config
