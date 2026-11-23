// 把打好的 APK 发到 GitHub Release，手机直接点链接下载安装。
// 令牌与推送用的是同一份（Windows 凭据管理器里的 github.com 凭据）。
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = process.env.DEPLOY_OWNER ?? '324641aliyun'
const REPO = process.env.DEPLOY_REPO ?? 'deepseek-chat-pwa'
const TAG = process.env.RELEASE_TAG ?? 'v1.0.0'
const APK = join(appDir, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')

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
          'Android 安装包（debug 签名，个人使用）。',
          '',
          '- 内置 PWA 全部能力，另加原生网络：`web_fetch` 不需要电脑、`read_bilibili_video` 可读 B 站画面。',
          '- 首次打开在设置里填 DeepSeek API Key；对话与 Key 只存在本机。',
          '- 网页版仍在 https://324641aliyun.github.io/deepseek-chat-pwa/ 。',
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
  if (asset.name === 'app-debug.apk') {
    await api(`/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, { method: 'DELETE' })
    console.log('deleted old asset')
  }
}

const uploadUrl = String(release.upload_url).replace('{?name,label}', '?name=app-debug.apk')
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
