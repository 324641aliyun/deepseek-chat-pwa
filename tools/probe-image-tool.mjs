// 探针：tool_result 里能不能带图片块（B 站帧要靠这个交给模型看）。
// 先上传一张 PNG 拿 file_id，再构造 assistant(tool_use) + user(tool_result[image]) 的请求。
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
const uploadText = await upload.text()
console.log('upload', upload.status, uploadText.slice(0, 300))
if (!upload.ok) process.exit(1)
const file = JSON.parse(uploadText)
console.log('file_id', file.id, 'size', file.size_bytes)

const base = {
  model: 'deepseek-flash',
  max_tokens: 512,
  thinking: { type: 'enabled' },
  safety_check: { level: 'high' },
  tools: [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
    {
      name: 'read_bilibili_video',
      description: 'Return sampled frames of a Bilibili video as images.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  ],
}

const ask = async (label, toolResultContent) => {
  const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: JSON.stringify({
      ...base,
      messages: [
        { role: 'latest_reminder', content: '2026-11-23,星期一,,Web,中文' },
        { role: 'user', content: '看一下这个视频的画面，用 read_bilibili_video。' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_bili_1', name: 'read_bilibili_video', input: { url: 'BV1xx' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_bili_1', content: toolResultContent }] },
      ],
    }),
  })
  const text = await response.text()
  console.log(`[${label}] ${response.status} ${text.slice(0, 400)}`)
  return response.ok
}

// 1) tool_result 内容为 [图片块, 文本块]
const withImage = await ask('image-in-tool-result', [
  { type: 'image', source: { type: 'file', file_id: file.id } },
  { type: 'text', text: '这是视频第 0 秒的画面，尺寸 480x270。' },
])

// 2) 退路：tool_result 只给文本，图片作为紧接着的 user 消息
const fallbackOk = await ask('text-only', '已取到 1 帧，见随后的图片消息。')
if (fallbackOk) {
  const followUp = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: JSON.stringify({
      ...base,
      messages: [
        { role: 'latest_reminder', content: '2026-11-23,星期一,,Web,中文' },
        { role: 'user', content: '看一下这个视频的画面，用 read_bilibili_video。' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_bili_1', name: 'read_bilibili_video', input: { url: 'BV1xx' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_bili_1', content: '已取到 1 帧。' },
            { type: 'image', source: { type: 'file', file_id: file.id } },
            { type: 'text', text: '以上是第 0 秒的画面。' },
          ],
        },
      ],
    }),
  })
  const followText = await followUp.text()
  console.log(`[image-in-user-message] ${followUp.status} ${followText.slice(0, 400)}`)
}

process.exit(withImage ? 0 : 1)
