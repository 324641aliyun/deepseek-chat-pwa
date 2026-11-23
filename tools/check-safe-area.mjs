// 全面屏留白验证：模拟外壳注入 --safe-area-inset-*，检查页面是否真的让开了状态栏与手势条。
// 用法：node tools/check-safe-area.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = normalize(join(fileURLToPath(import.meta.url), '..', '..'))
const DIST = join(root, 'dist')
const PORT = 8097

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

const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
].find((candidate) => candidate && existsSync(candidate))
if (!chrome) {
  console.error('找不到 Chrome')
  process.exit(2)
}

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
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const profile = await mkdtemp(join(tmpdir(), 'dsh-safearea-'))
const chromeProcess = spawn(chrome, [
  '--headless=new',
  '--remote-debugging-port=9223',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--disable-gpu',
  '--window-size=430,900',
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let cdp
try {
  let target
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) break
    } catch {
      // 端口未就绪
    }
    await wait(250)
  }
  if (!target) throw new Error('DevTools 未就绪')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data.result)
      pending.delete(data.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  cdp = { socket, send, evaluate }

  await send('Runtime.enable')
  await wait(2500)

  const mockInsets = async (top, bottom) => {
    await evaluate(`(() => {
      document.documentElement.style.setProperty('--safe-area-inset-top', '${top}px')
      document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottom}px')
      document.documentElement.style.setProperty('--safe-area-inset-left', '0px')
      document.documentElement.style.setProperty('--safe-area-inset-right', '0px')
    })()`)
    await wait(200)
    return evaluate(`(() => {
      const frame = document.querySelector('[class*="frame"]')
      if (!frame) return null
      const style = getComputedStyle(frame)
      const rect = frame.getBoundingClientRect()
      return {
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        frameTop: Math.round(rect.top),
        frameBottom: Math.round(rect.bottom),
        viewport: window.innerHeight,
      }
    })()`)
  }

  const before = await mockInsets(0, 0)
  const after = await mockInsets(48, 34)
  console.log('无留白时:', JSON.stringify(before))
  console.log('模拟 48/34 留白:', JSON.stringify(after))

  const passed =
    after && after.paddingTop === '48px' && after.paddingBottom === '34px' && before?.paddingTop === '0px'
  console.log(passed ? '\n全面屏留白生效' : '\n留白未生效')
  process.exitCode = passed ? 0 : 1
} catch (error) {
  console.error('验证失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  cdp?.socket.close()
  server.close()
  chromeProcess.kill()
  await wait(400)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}

