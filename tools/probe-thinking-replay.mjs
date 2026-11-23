// 探针：思考模式下，assistant 的 thinking 块是否必须原样回传；
// 以及 tool_result 里能不能带图片块。用真实的流式响应取 signature，再回放。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const key = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  .match(/^\s*DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9]+)/m)?.[1]
if (!key) throw new Error('no key')

const png = readFileSync(join(import.meta.dirname, '..', 'public', 'icons', 'icon-192.png'))
const form = new FormData()
form.append('file', new Blob([png], { type: 'image/png' }), 'frame.png')
const upload = await fetch('https://api.deepseek.com/anthropic/v1/files', {
  method: 'POST',
  headers: { 'x-api-key': key, 'anthropic-beta': 'files-api-2025-04-14' },
  body: form,
})
const file = await upload.json()
console.log('file', upload.status, file.id)

const tools = [
  { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  {
    name: 'read_bilibili_video',
    description: 'Return sampled frames of a Bilibili video as images.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
]
const headers = {
  'x-api-key': key,
  'content-type': 'application/json',
  accept: 'text/event-stream',
  'anthropic-beta': 'files-api-2025-04-14',
}
const reminder = { role: 'latest_reminder', content: '2026-11-23,星期一,,Web,中文' }

const streamRound = async (messages) => {
  const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'deepseek-flash',
      max_tokens: 1024,
      thinking: { type: 'enabled' },
      safety_check: { level: 'high' },
      tools,
      messages,
      stream: true,
    }),
  })
  if (!response.ok) {
    console.log('stream failed', response.status, (await response.text()).slice(0, 300))
    return null
  }
  const decoder = new TextDecoder()
  let buffer = ''
  const blocks = new Map()
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let event
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      if (event.type === 'content_block_start') {
        blocks.set(event.index, { ...event.content_block })
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index)
        if (!block) continue
        if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + event.delta.thinking
        if (event.delta.type === 'signature_delta') block.signature = (block.signature ?? '') + event.delta.signature
        if (event.delta.type === 'text_delta') block.text = (block.text ?? '') + event.delta.text
        if (event.delta.type === 'input_json_delta') block.__json = (block.__json ?? '') + event.delta.partial_json
      }
    }
  }
  const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block)
  const tool = content.find((block) => block.type === 'tool_use')
  if (tool?.__json) {
    try {
      tool.input = JSON.parse(tool.__json)
    } catch {
      // 保持原始 input
    }
    delete tool.__json
  }
  return { content, tool }
}

const question = '用 read_bilibili_video 取 BV1xx 的视频帧。'
const first = await streamRound([reminder, { role: 'user', content: question }])
console.log('round1 blocks', first?.content.map((block) => block.type).join(','))
const thinking = first?.content.find((block) => block.type === 'thinking')
const tool = first?.tool
if (!tool) process.exit(1)
console.log('signature length', thinking?.signature?.length ?? 0)

const attempt = async (label, assistantContent) => {
  const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-beta': 'files-api-2025-04-14' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      max_tokens: 512,
      thinking: { type: 'enabled' },
      safety_check: { level: 'high' },
      tools,
      messages: [
        reminder,
        { role: 'user', content: question },
        { role: 'assistant', content: assistantContent },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: tool.id,
              content: [
                { type: 'image', source: { type: 'file', file_id: file.id } },
                { type: 'text', text: '第 0 秒的画面，480x270。' },
              ],
            },
          ],
        },
      ],
      stream: false,
    }),
  })
  const text = await response.text()
  console.log(`[${label}] ${response.status} ${response.ok ? 'ok' : text.slice(0, 240)}`)
  return response.ok
}

await attempt('with-thinking+image', [
  { type: 'thinking', thinking: thinking.thinking, signature: thinking.signature },
  { type: 'tool_use', id: tool.id, name: tool.name, input: tool.input },
])
await attempt('no-thinking+image', [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }])
await attempt('with-thinking+text-only', [
  { type: 'thinking', thinking: thinking.thinking, signature: thinking.signature },
  { type: 'tool_use', id: tool.id, name: tool.name, input: tool.input },
])
