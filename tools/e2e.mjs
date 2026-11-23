// 浏览器端到端验证：用真实 Chrome 打开构建产物，走两轮对话，确认多轮工具调用与跨轮历史回放。
// 用法：
//   node tools/e2e.mjs                        # 打本地 dist
//   $env:E2E_URL='https://.../'; node tools/e2e.mjs   # 打已部署站点
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = normalize(join(fileURLToPath(import.meta.url), '..', '..'))
const DIST = join(root, 'dist')
const PORT = 8099

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const chromePath = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate))
if (!chromePath) {
  console.error('找不到 Chrome/Edge，无法跑端到端验证')
  process.exit(2)
}

const serve = () =>
  new Promise((resolve) => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      let file = normalize(join(DIST, decodeURIComponent(url.pathname)))
      if (!file.startsWith(DIST)) {
        response.writeHead(403).end()
        return
      }
      if (!extname(file)) {
        file = join(DIST, 'index.html')
      }
      try {
        const body = await readFile(file)
        response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        response.end(body)
      } catch {
        response.writeHead(404).end('not found')
      }
    })
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.logs = []
    socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id)
        this.pending.delete(data.id)
        if (data.error) {
          reject(new Error(`${data.error.message} ${JSON.stringify(data.error.data ?? '')}`))
        } else {
          resolve(data.result)
        }
        return
      }
      if (data.method === 'Runtime.consoleAPICalled') {
        const text = (data.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ')
        this.logs.push(`[console.${data.params.type}] ${text}`)
      }
      if (data.method === 'Runtime.exceptionThrown') {
        this.logs.push(
          `[exception] ${data.params.exceptionDetails?.text} ${data.params.exceptionDetails?.exception?.description ?? ''}`
        )
      }
      if (data.method === 'Log.entryAdded') {
        this.logs.push(`[log.${data.params.entry.level}] ${data.params.entry.text}`)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.nextId
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    this.socket.close()
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readApiKey = async () => {
  const yaml = await readFile(join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml'), 'utf8')
  return yaml.match(/^\s*DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9]+)/m)?.[1]
}

const server = process.env.E2E_URL ? null : await serve()
const targetUrl = process.env.E2E_URL ?? `http://127.0.0.1:${PORT}/`
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-e2e-chrome-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=430,900',
    targetUrl,
  ],
  { stdio: 'ignore', detached: false }
)

let cdp
try {
  let target
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) break
    } catch {
      // 端口还没就绪
    }
    await wait(250)
  }
  if (!target) {
    throw new Error('Chrome DevTools 端口未就绪')
  }

  cdp = new Cdp(new WebSocket(target.webSocketDebuggerUrl))
  await new Promise((resolve) => cdp.socket.addEventListener('open', resolve, { once: true }))
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url: targetUrl })
  await wait(3000)

  const apiKey = await readApiKey()
  if (!apiKey) {
    throw new Error('没找到 DEEPSEEK_API_KEY')
  }
  await cdp.evaluate(`localStorage.setItem('chat-demo:api-key', ${JSON.stringify(apiKey)})`)
  await cdp.evaluate('location.reload()')
  await wait(2500)

  if (!(await cdp.evaluate(`!!document.querySelector('textarea')`))) {
    throw new Error('页面没有渲染出输入框')
  }

  const ask = async (text) => {
    await cdp.evaluate(`(() => {
      const textarea = document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(text)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.focus()
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()`)
  }

  const state = () =>
    cdp.evaluate(`(() => ({
      text: document.body.innerText,
      tools: document.querySelectorAll('[class*="toolToggle"]').length,
    }))()`)

  const waitSettled = async (minTools, pattern, timeout = 150_000) => {
    const deadline = Date.now() + timeout
    let previous = ''
    let stable = 0
    let snapshot = await state()
    while (Date.now() < deadline) {
      await wait(1000)
      snapshot = await state()
      const hit = snapshot.tools >= minTools && pattern.test(snapshot.text)
      if (hit && snapshot.text === previous) {
        stable += 1
        if (stable >= 2) {
          return snapshot
        }
      } else {
        stable = 0
      }
      previous = snapshot.text
    }
    return snapshot
  }

  // 第一轮：两次数值计算，验证同一轮里连续多轮工具调用
  await ask('先用 calculate 工具算 1234 * 5678，再用 calculate 工具算上一步结果除以 7 的余数。只回答最终余数。')
  const first = await waitSettled(2, /已执行 calculate/)
  console.log('第一轮工具卡片：', first.tools)
  console.log('第一轮片段：', first.text.replace(/\s+/g, ' ').slice(0, 600))

  // 第二轮：让它回头读第 1 轮，验证历史里的工具往返能重建成合法请求
  await ask('用 read_conversation 读一下第 1 轮，然后原样复述我当时问的那句话。')
  const second = await waitSettled(3, /1234\s*\*\s*5678/)
  console.log('第二轮工具卡片：', second.tools)
  console.log('第二轮片段：', second.text.replace(/\s+/g, ' ').slice(0, 900))

  if (cdp.logs.length > 0) {
    console.log('\n浏览器日志：')
    for (const line of cdp.logs.slice(0, 20)) {
      console.log(' ', line)
    }
  }

  const passed = first.tools >= 2 && second.tools >= 3 && /1234\s*\*\s*5678/.test(second.text)
  console.log(passed ? '\n端到端通过：同一轮多工具 + 跨轮历史回放' : '\n端到端未通过')
  process.exitCode = passed ? 0 : 1
} catch (error) {
  console.error('端到端失败：', error instanceof Error ? error.message : error)
  if (cdp?.logs?.length) {
    console.log(cdp.logs.slice(0, 20).join('\n'))
  }
  process.exitCode = 1
} finally {
  cdp?.close()
  server?.close()
  if (!process.argv.includes('--keep')) {
    chrome.kill()
    await wait(500)
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}
