// 浏览器端到端验证：用真实 Chrome 打开构建产物，走一遍「输入问题 → 多轮工具调用 → 回答」。
// 用法：node tools/e2e.mjs [--keep]
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
          reject(new Error(`${data.error.message} (${JSON.stringify(data.error.data ?? '')})`))
        } else {
          resolve(data.result)
        }
        return
      }
      if (data.method === 'Runtime.consoleAPICalled') {
        const text = (data.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
        this.logs.push(`[console.${data.params.type}] ${text}`)
      }
      if (data.method === 'Runtime.exceptionThrown') {
        this.logs.push(`[exception] ${data.params.exceptionDetails?.text} ${data.params.exceptionDetails?.exception?.description ?? ''}`)
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

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
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

const server = await serve()
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
    `http://127.0.0.1:${PORT}/`,
  ],
  { stdio: 'ignore', detached: false }
)

let cdp
try {
  // 等 DevTools 端口就绪
  let target
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) break
    } catch {
      // 端口还没起来
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

  const apiKey = await readApiKey()
  if (!apiKey) {
    throw new Error('没找到 DEEPSEEK_API_KEY')
  }

  // 写入 API Key 后重载，避免首次渲染时空 key
  await cdp.evaluate(`localStorage.setItem('chat-demo:api-key', ${JSON.stringify(apiKey)})`)
  await cdp.evaluate('location.reload()')
  await wait(2500)

  const ready = await cdp.evaluate(`!!document.querySelector('textarea')`)
  if (!ready) {
    throw new Error('页面没有渲染出输入框')
  }

  const question = '先用 calculate 工具算 1234 * 5678，再用 calculate 工具算上一步结果除以 7 的余数。只回答最终余数。'
  await cdp.evaluate(`(() => {
    const textarea = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, ${JSON.stringify(question)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.focus()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return textarea.value
  })()`)

  const deadline = Date.now() + 120_000
  let snapshot = { text: '', tools: 0, done: false }
  while (Date.now() < deadline) {
    snapshot = await cdp.evaluate(`(() => {
      const body = document.body.innerText
      const tools = document.querySelectorAll('[class*="toolToggle"]').length
      const stop = !!document.querySelector('[class*="stop"]')
      return { text: body, tools, done: !stop }
    })()`)
    const hasAnswer = /余数|42668365|2\b/.test(snapshot.text) && snapshot.tools > 0
    if (hasAnswer && snapshot.text.length > 80) {
      // 再等两秒，让最后一轮文本落定
      await wait(2500)
      snapshot = await cdp.evaluate(`(() => ({
        text: document.body.innerText,
        tools: document.querySelectorAll('[class*="toolToggle"]').length,
        done: true,
      }))()`)
      break
    }
    await wait(1000)
  }

  const normalized = snapshot.text.replace(/\s+/g, ' ').slice(0, 1200)
  console.log('工具卡片数量：', snapshot.tools)
  console.log('页面文本片段：', normalized)
  if (cdp.logs.length > 0) {
    console.log('\n浏览器日志：')
    for (const line of cdp.logs.slice(0, 30)) {
      console.log(' ', line)
    }
  }

  const passed = snapshot.tools >= 2 && /42668365|\b\d+\b/.test(snapshot.text)
  console.log(passed ? '\n端到端通过：多轮工具调用完成' : '\n端到端未通过：检查上面的页面文本与日志')
  process.exitCode = passed ? 0 : 1
} catch (error) {
  console.error('端到端失败：', error instanceof Error ? error.message : error)
  if (cdp?.logs?.length) {
    console.log(cdp.logs.slice(0, 30).join('\n'))
  }
  process.exitCode = 1
} finally {
  cdp?.close()
  server.close()
  if (!process.argv.includes('--keep')) {
    chrome.kill()
    await wait(500)
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
}
