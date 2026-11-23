// 验证：历史里带客户端工具往返的请求，服务端是否接受。
// 构造的是 toRequestMessages 真实会产出的两种形状：
//   1) 中间轮：assistant(正文 + tool_use) → user(tool_result) → assistant(后续正文)
//   2) 末尾轮：assistant(正文 + tool_use) → user(tool_result + 新问题)
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const key = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  .match(/^\s*DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9]+)/m)?.[1]
if (!key) throw new Error('no key')

const tools = [
  { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  {
    name: 'calculate',
    description: 'Evaluate bounded arithmetic.',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
  {
    name: 'read_conversation',
    description: 'Read turns of this conversation.',
    input_schema: { type: 'object', properties: { turn: { type: 'number' } } },
  },
]

const reminder = '2026-11-23,星期一,,Web,中文'

const send = async (label, messages) => {
  const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      max_tokens: 512,
      thinking: { type: 'enabled' },
      safety_check: { level: 'high' },
      tools,
      messages,
      stream: false,
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    console.log(`[${label}] ${response.status}: ${text.slice(0, 500)}`)
    return false
  }
  const json = JSON.parse(text)
  console.log(
    `[${label}] ok stop=${json.stop_reason} blocks=${json.content.map((block) => block.type).join(',')}`
  )
  return true
}

// 1) 中间轮形状
const middle = await send('middle-turn', [
  { role: 'latest_reminder', content: reminder },
  { role: 'user', content: '算一下 1234 * 5678。' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我先算一下。' },
      { type: 'tool_use', id: 'call_1', name: 'calculate', input: { expression: '1234 * 5678' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '7006652' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: '结果是 7006652。' }] },
  { role: 'user', content: '用 read_conversation 读一下第 1 轮，然后复述。' },
])

// 2) 末尾轮形状：工具结果与新问题在同一条 user 消息里
const tail = await send('tail-merged', [
  { role: 'latest_reminder', content: reminder },
  { role: 'user', content: '算一下 6 * 7。' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_2', name: 'calculate', input: { expression: '6 * 7' } }],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_2', content: '42' },
      { type: 'text', text: '再算 42 * 2。' },
    ],
  },
])

process.exit(middle && tail ? 0 : 1)
