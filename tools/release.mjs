// 把打好的 APK 发到 GitHub Release，手机直接点链接下载安装。
// 令牌与推送用的是同一份（Windows 凭据管理器里的 github.com 凭据）。
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = process.env.DEPLOY_OWNER ?? '324641aliyun'
const REPO = process.env.DEPLOY_REPO ?? 'deepseek-chat-pwa'
const TAG = process.env.RELEASE_TAG ?? 'v1.1.0'
const APK = join(appDir, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const ASSET = 'deepseek-chat-1.1.0.apk'

const token = (() => {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  return result.stdout?.match(/^password=(.+)$/m)?.[1]
})()
if (!token) {
  throw new Error('没有从 git 凭据管理器拿到 github.com 令牌')
}

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'deepseek-chat-demo-release',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} → ${response.status} ${body?.message ?? text}`)
  }
  return body
}

if (!statSync(APK, { throwIfNoEntry: false })) {
  throw new Error(`APK 不存在：${APK}`)
}
const size = statSync(APK).size
console.log(`APK ${(size / 1024 / 1024).toFixed(2)} MB`)

const release = await (async () => {
  try {
    return await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`)
  } catch {
    return await api(`/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: TAG,
        name: `手机版 ${TAG}`,
        body: [
          'Android 安装包（自签名 release 构建，个人使用）。',
          '',
          '本版修复：',
          '- 全面屏适配：状态栏、挖孔、手势条留白（HyperOS / Android 15+ 强制 edge-to-edge），弹窗与搜索面板同样让开。',
          '- B 站视频读取：打开 WebView 原生网络（CapacitorHttp），加入风控重试与画布兼容回退。',
          '- 网页抓取：改为原生网络，不再依赖电脑上的本地服务。',
          '- 语音输入：消息带「语音输入」标记，并向模型说明这是转写文本，便于自行纠错。',
          '- release 构建：R8 压缩、资源裁剪、非 debuggable，包体从 6.1 MB 降到约 2.7 MB；启动图标换成品牌图标。',
          '',
          '首次打开在设置里填 DeepSeek API Key；对话、附件与 Key 只存本机。',
          '网页版仍在 https://324641aliyun.github.io/deepseek-chat-pwa/ 。',
        ].join('\n'),
        draft: false,
        prerelease: false,
      }),
    })
  }
})()

console.log(`release: ${release.html_url}`)

// 已存在同名 asset 时先删掉，便于重复发布
for (const asset of release.assets ?? []) {
  if (asset.name === ASSET || asset.name === 'app-debug.apk') {
    await api(`/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, { method: 'DELETE' })
    console.log('deleted old asset')
  }
}

const uploadUrl = String(release.upload_url).replace('{?name,label}', '?name=' + ASSET + '')
const upload = await fetch(uploadUrl, {
  method: 'POST',
  headers: {
    authorization: `token ${token}`,
    'content-type': 'application/vnd.android.package-archive',
    'content-length': String(size),
    'user-agent': 'deepseek-chat-demo-release',
  },
  body: readFileSync(APK),
})
const uploaded = await upload.json()
if (!upload.ok) {
  throw new Error(`上传失败 ${upload.status}: ${uploaded?.message ?? ''}`)
}
console.log(`asset: ${uploaded.browser_download_url}`)
console.log(`安装包大小：${(uploaded.size / 1024 / 1024).toFixed(2)} MB`)

