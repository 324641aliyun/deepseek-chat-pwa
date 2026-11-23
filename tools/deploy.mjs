// 部署到 GitHub Pages：建仓库（需要时）→ 提交 → 推 main → 启用 Pages → 等构建完成。
// 令牌来自 Windows 凭据管理器里 git 保存的 github.com 凭据，只在本进程内使用，不写进 .git/config。
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = process.env.DEPLOY_REPO ?? 'deepseek-chat-pwa'
const OWNER = '324641aliyun'

const run = (args, options = {}) =>
  execFileSync('git', args, { cwd: appDir, encoding: 'utf8', ...options }).trim()

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
      'user-agent': 'deepseek-chat-demo-deploy',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const message = body?.message ?? text
    const error = new Error(`GitHub API ${init.method ?? 'GET'} ${path} → ${response.status} ${message}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

const ensureRepo = async () => {
  try {
    const repo = await api(`/repos/${OWNER}/${REPO}`)
    console.log(`仓库已存在：${repo.full_name}`)
    return repo
  } catch (error) {
    if (error.status !== 404) throw error
  }
  const repo = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO,
      description: 'DeepSeek 官方 chat-demo 的手机版：多轮工具调用、自动压缩、可安装到主屏幕',
      private: false,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    }),
  })
  console.log(`已创建仓库：${repo.full_name}`)
  return repo
}

const repo = await ensureRepo()
const remoteUrl = `https://github.com/${OWNER}/${REPO}.git`

// 首次提交：把工作副本作为新仓库的历史
if (!existsSync(join(appDir, '.git'))) {
  run(['init', '-b', 'main'])
  run(['config', 'user.name', OWNER])
  run(['config', 'user.email', `${OWNER}@users.noreply.github.com`])
  console.log('已初始化 git 仓库')
}

const hasCommit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: appDir }).status === 0
run(['add', '-A'])
const staged = run(['status', '--porcelain'])
if (!hasCommit || staged) {
  run(['commit', '-m', hasCommit ? 'chore: update build' : 'feat: DeepSeek chat-demo 手机版（多轮工具调用 + PWA）'])
  console.log(hasCommit ? '已提交新改动' : '已创建首个提交')
}

// 先直接用系统凭据管理器推送；失败再退化到 askpass，避免令牌落进 .git/config 或命令行
spawnSync('git', ['remote', 'remove', 'origin'], { cwd: appDir })
run(['remote', 'add', 'origin', remoteUrl])
const pushEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
let pushed = spawnSync('git', ['push', '-u', 'origin', 'main', '--force'], {
  cwd: appDir,
  env: pushEnv,
  encoding: 'utf8',
})
if (pushed.status !== 0) {
  const askpass = join(appDir, '.git-askpass.cmd')
  writeFileSync(
    askpass,
    [
      '@echo off',
      'echo %1 | findstr /i "username" >nul',
      `if %errorlevel%==0 (echo ${OWNER}) else (echo %DEPLOY_TOKEN%)`,
    ].join('\r\n')
  )
  pushed = spawnSync('git', ['push', '-u', 'origin', 'main', '--force'], {
    cwd: appDir,
    encoding: 'utf8',
    env: {
      ...pushEnv,
      GIT_ASKPASS: askpass,
      DEPLOY_TOKEN: token,
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  unlinkSync(askpass)
}
if (pushed.status !== 0) {
  throw new Error(`推送失败：${pushed.stderr || pushed.stdout}`)
}
console.log('已推送 main')

// 启用 Pages（Actions 构建）
try {
  await api(`/repos/${OWNER}/${REPO}/pages`, {
    method: 'POST',
    body: JSON.stringify({ build_type: 'workflow' }),
  })
  console.log('已启用 Pages（workflow 构建）')
} catch (error) {
  if (error.status === 409) {
    await api(`/repos/${OWNER}/${REPO}/pages`, {
      method: 'PUT',
      body: JSON.stringify({ build_type: 'workflow' }),
    })
    console.log('Pages 已存在，已切换为 workflow 构建')
  } else {
    throw error
  }
}

const url = `https://${OWNER}.github.io/${REPO}/`
console.log(`\n站点地址：${url}`)
console.log('等待 Actions 构建（通常 1-2 分钟）…')

for (let attempt = 0; attempt < 60; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 5000))
  let page
  try {
    page = await api(`/repos/${OWNER}/${REPO}/pages`)
  } catch {
    continue
  }
  if (page.status === 'built' && page.html_url) {
    console.log(`Pages 已构建：${page.html_url}`)
    break
  }
  const runs = await api(`/repos/${OWNER}/${REPO}/actions/runs?per_page=1`).catch(() => null)
  const latest = runs?.workflow_runs?.[0]
  if (latest) {
    console.log(`  ${latest.name}: ${latest.status}/${latest.conclusion ?? '-'}`)
    if (latest.conclusion === 'failure') {
      console.log(`  查看日志：${latest.html_url}`)
      break
    }
  }
}

const check = await fetch(url).catch(() => null)
console.log(`\n站点可达性：${check ? check.status : '请求失败'}`)
