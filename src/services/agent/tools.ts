import type { ClientToolDef } from '../api/types.js'
import type { FileAttachment, Message } from '../chat/types.js'
import * as db from '../chat/db.js'
import { fetchPage } from './helper.js'
import { readConversation, searchConversation } from './tools/conversation.js'
import { calculate } from './tools/math.js'

/** 单个工具结果进入上下文前的字符上限，超出部分截断并注明 */
const DEFAULT_LIMIT = 20_000
/** 上传文本附件的读取上限，与 DSH 预设保持一致 */
const UPLOAD_LIMIT = 2 * 1024 * 1024

export type ToolContext = {
  /** 当前会话按分支展开后的全部消息（含已被检查点覆盖的轮次，检索要能查到） */
  messages: Message[]
  /** 本会话里用户上传的附件 */
  files: FileAttachment[]
  /** 可选本地工具服务基地址 */
  helperUrl: string | null
  signal: AbortSignal
}

export type AgentTool = {
  name: string
  description: string
  input_schema: ClientToolDef['input_schema']
  /** 结果截断上限（字符） */
  limit?: number
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string
}

const asString = (input: Record<string, unknown>, key: string): string => {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`参数 ${key} 必须是非空字符串`)
  }
  return value
}

const optionalString = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

const optionalNumber = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 只读会话中用户明确上传过的附件；路径、其他会话的文件都不接受 */
const readUploadedFile = async (
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> => {
  const id = optionalString(input, 'id')
  if (!id) {
    return JSON.stringify({
      files: ctx.files.map((file) => ({
        id: file.id,
        name: file.name,
        size: file.size,
        type: file.isImage ? 'image' : 'file',
      })),
    })
  }
  const file = ctx.files.find((item) => item.id === id)
  if (!file) {
    throw new Error('这个文件没有在本会话里由用户上传，无法读取')
  }
  if (file.size > UPLOAD_LIMIT) {
    throw new Error('附件超过 2 MiB 的读取上限')
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    throw new Error('附件原件不在本地存储里（可能是导入的记录），无法读取正文')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.includes(0)) {
    throw new Error('这个附件是二进制文件，只能读取文本')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('附件不是 UTF-8 文本，无法读取')
  }
}

const webFetch = async (input: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
  const url = asString(input, 'url')
  if (!ctx.helperUrl) {
    throw new Error('本地工具服务没有配置，无法抓取网页正文；改用内置的联网搜索或链接阅读')
  }
  const page = await fetchPage(ctx.helperUrl, url, ctx.signal)
  const header = [`URL: ${page.url}`, page.title ? `标题: ${page.title}` : null]
    .filter(Boolean)
    .join('\n')
  return `${header}\n\n${page.text}${page.truncated ? '\n\n（正文过长，已截断）' : ''}`
}

/** 全部工具；本地服务未配置时不注册依赖它的工具，避免模型调用后失败 */
export const buildAgentTools = (options: { helperUrl: string | null }): AgentTool[] => {
  const tools: AgentTool[] = [
    {
      name: 'calculate',
      description:
        '计算有限算术表达式，支持 + - * / % ^、括号、pi、e 和 sqrt/abs/sin/cos/tan/log/log10/exp/floor/ceil/round。不做代码执行。',
      input_schema: {
        type: 'object',
        properties: { expression: { type: 'string', description: '要计算的表达式' } },
        required: ['expression'],
        additionalProperties: false,
      },
      run: (input) => String(calculate(asString(input, 'expression'))),
    },
    {
      name: 'search_conversation',
      description:
        '在本会话的全部历史里搜索用户说过的话和模型回答（包括已被压缩成检查点的旧轮次）。支持关键词（默认）、正则、指定轮次区间和最近若干轮。返回命中的轮次与片段。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键词；regex 为 true 时按正则解释' },
          regex: { type: 'boolean', description: '是否把 query 当作 JavaScript 正则' },
          turns: {
            type: 'string',
            description: "轮次范围：'all'（默认）、'last:10' 或 '1,3,5-8'",
          },
          includeToolResults: { type: 'boolean', description: '是否连工具结果一起搜' },
          limit: { type: 'number', description: '最多返回多少条，默认 20，最大 50' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      limit: 12_000,
      run: (input, ctx) =>
        searchConversation(ctx.messages, {
          query: optionalString(input, 'query'),
          regex: input.regex === true,
          turns: optionalString(input, 'turns'),
          includeToolResults: input.includeToolResults === true,
          limit: optionalNumber(input, 'limit'),
        }),
    },
    {
      name: 'read_conversation',
      description:
        '按轮次读取本会话的完整消息。指定 turn 读一轮，turnFrom/turnTo 读区间，messageId 读单条；都不给时读最后一轮。',
      input_schema: {
        type: 'object',
        properties: {
          turn: { type: 'number', description: '轮次编号，从 1 开始' },
          turnFrom: { type: 'number', description: '起始轮次' },
          turnTo: { type: 'number', description: '结束轮次' },
          messageId: { type: 'string', description: '单条消息的 id' },
        },
        additionalProperties: false,
      },
      limit: 30_000,
      run: (input, ctx) =>
        readConversation(ctx.messages, {
          turn: optionalNumber(input, 'turn'),
          turnFrom: optionalNumber(input, 'turnFrom'),
          turnTo: optionalNumber(input, 'turnTo'),
          messageId: optionalString(input, 'messageId'),
        }),
    },
    {
      name: 'read_uploaded_file',
      description:
        '列出用户在本会话里上传的文件，或按 id 读取其中一个 UTF-8 文本附件的全文。只接受本会话的上传，不接受路径。',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: '文件 id；省略则列出全部上传' } },
        additionalProperties: false,
      },
      run: (input, ctx) => readUploadedFile(input, ctx),
    },
  ]
  if (options.helperUrl) {
    tools.push({
      name: 'web_fetch',
      description: '用电脑上的本地工具服务抓取一个公开网页的正文并阅读。适合需要读全文的链接。',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http/https 链接' } },
        required: ['url'],
        additionalProperties: false,
      },
      limit: 40_000,
      run: (input, ctx) => webFetch(input, ctx),
    })
  }
  return tools
}

/** 转成接口要求的工具声明 */
export const toToolDefinitions = (tools: AgentTool[]): ClientToolDef[] =>
  tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))

export type ToolRunResult = { text: string; isError: boolean }

/** 执行一次工具调用：统一截断、统一把异常变成 is_error 结果，模型能看到失败原因 */
export const runTool = async (
  tools: AgentTool[],
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolRunResult> => {
  const tool = tools.find((item) => item.name === name)
  if (!tool) {
    return { text: `调用了不存在的工具：${name}`, isError: true }
  }
  try {
    const raw = await tool.run(input, ctx)
    const limit = tool.limit ?? DEFAULT_LIMIT
    const text = raw.length > limit ? `${raw.slice(0, limit)}\n\n（结果过长，已截断）` : raw
    return { text, isError: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}
