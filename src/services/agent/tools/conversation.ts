import type { AssistantMessage, Message, UserMessage } from '../../chat/types.js'

/**
 * 会话检索与读取工具：对已加载到前端的消息数组做纯函数查询，
 * 供模型通过 function calling 回顾本会话里说过的话。
 */

/** 单次搜索默认返回的命中条数。 */
const DEFAULT_SEARCH_LIMIT = 20

/** 单次搜索最多返回的命中条数；更多命中交给 total 与 matchedTurns 提示。 */
const MAX_SEARCH_LIMIT = 50

/** snippet 在命中位置左右各保留多少字符。 */
const SNIPPET_CONTEXT = 80

/** readConversation 一次最多读取的轮数，避免把整个会话塞进一次结果。 */
const MAX_READ_TURNS = 50

export interface SearchArgs {
  /** 关键词；regex 为 false 时按字面量、大小写不敏感匹配，多个词需同时出现 */
  query?: string
  /** true 时 query 按 JavaScript 正则（大小写不敏感）解释，非法正则抛错 */
  regex?: boolean
  /** 轮次范围：'all'（默认）、'last:20' 或 '1,3,5-8' */
  turns?: string
  /** 是否连工具结果一起检索，默认关闭 */
  includeToolResults?: boolean
  /** 最多返回多少条命中，默认 20，最大 50 */
  limit?: number
}

export interface ReadArgs {
  /** 只读这一轮 */
  turn?: number
  /** 区间起点；只给 turnFrom 时按单轮处理 */
  turnFrom?: number
  /** 区间终点，含端点；缺省时等于 turnFrom */
  turnTo?: number
  /** 只读这一条消息 */
  messageId?: string
}

/** 一条搜索命中；同一条消息最多产生一条，取消息内的第一处命中。 */
type SearchMatch = {
  turn: number
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
}

/** 一轮：由一条用户消息开启，其后的助手消息都归进来。 */
type ConversationTurn = {
  turn: number
  messages: Message[]
}

/**
 * 助手消息块的运行时形状。类型里目前只有 text / thinking / 服务端工具块，
 * 客户端工具块（client_tool）由后续改动加入，这里按字段读取，不依赖未声明的联合成员。
 */
type ConversationBlock = {
  type?: string
  text?: unknown
  name?: unknown
  input?: unknown
  status?: unknown
  result?: unknown
  isError?: unknown
}

/** 轮次选择：全部、最近 N 轮，或若干闭区间。 */
type TurnSelection =
  | { kind: 'all' }
  | { kind: 'last'; count: number }
  | { kind: 'ranges'; ranges: Array<{ from: number; to: number }> }

/**
 * 按用户消息切分轮次：每条用户消息开启一轮，其后的助手消息归入该轮。
 * 用户消息之前的助手消息归入第 0 轮（导入的异常数据里可能出现），避免内容静默丢失。
 */
function groupTurns(messages: Message[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let current: ConversationTurn | undefined
  let nextTurn = 1
  for (const message of messages) {
    if (message.role === 'user') {
      current = { turn: nextTurn, messages: [message] }
      nextTurn += 1
      turns.push(current)
      continue
    }
    if (current === undefined) {
      current = { turn: 0, messages: [] }
      turns.push(current)
    }
    current.messages.push(message)
  }
  return turns
}

/** 把工具参数或结果压成文本；非字符串优先用 JSON，循环引用等异常时退回 String。 */
function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 客户端工具块的可读文本。默认不拼进正文：上一轮的工具结果通常又长又旧，
 * 搜索历史对话时容易盖过用户真正说过的话，只有明确要查工具输出时才参与。
 */
function clientToolText(block: ConversationBlock): string {
  const name = typeof block.name === 'string' ? block.name : '未知工具'
  const failed = block.isError === true ? ' [失败]' : ''
  const status = typeof block.status === 'string' ? ` 状态: ${block.status}` : ''
  const input = block.input === undefined ? '' : ` 输入: ${stringifyValue(block.input)}`
  const result = block.result === undefined ? '' : ` 结果: ${stringifyValue(block.result)}`
  return `[工具 ${name}]${failed}${status}${input}${result}`
}

/** 助手正文：按顺序拼接所有 text 块；思考块默认不参与检索与读取。 */
function assistantText(message: AssistantMessage, includeToolResults: boolean): string {
  // blocks 的类型还不包含客户端工具块，先按结构读出，避免在这里写 any。
  const blocks = (message.blocks ?? []) as unknown as ConversationBlock[]
  const parts: string[] = []
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (typeof block.text === 'string') {
        parts.push(block.text)
      }
      continue
    }
    if (includeToolResults && block?.type === 'client_tool') {
      parts.push(clientToolText(block))
    }
  }
  return parts.join('\n')
}

/** 用户正文：content 原样保留；有附件时追加占位，让模型能搜到文件名。 */
function userText(message: UserMessage): string {
  const parts: string[] = []
  if (message.content !== '') {
    parts.push(message.content)
  }
  for (const file of message.files ?? []) {
    parts.push(`[附件: ${file.name}]`)
  }
  return parts.join('\n')
}

/** 一条消息参与检索与读取的文本；只有助手正文受 includeToolResults 影响。 */
function messageText(message: Message, includeToolResults: boolean): string {
  return message.role === 'user' ? userText(message) : assistantText(message, includeToolResults)
}

/**
 * 构造匹配器。关键词按空白拆成多个词、全部出现才算命中（忽略大小写与空白差异），
 * 每个词都按字面量转义；regex 直接用 query 构造不区分大小写的正则。
 */
function createPatterns(query: string, regex: boolean): RegExp[] {
  if (regex) {
    try {
      return [new RegExp(query, 'i')]
    } catch (error) {
      throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((term) => term !== '')
  if (terms.length === 0) {
    throw new Error('请提供要查找的关键词（query）')
  }
  return terms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
}

/**
 * 在文本里找第一处命中：关键词模式下每个词都要出现，snippet 取其中最长的那一处。
 * 正则不带 g 标志，exec 不保留 lastIndex，重复调用互不影响。
 */
function findMatch(text: string, patterns: RegExp[]): RegExpExecArray | undefined {
  let best: RegExpExecArray | undefined
  for (const pattern of patterns) {
    const found = pattern.exec(text)
    if (found === null) {
      return undefined
    }
    if (best === undefined || found[0].length > best[0].length) {
      best = found
    }
  }
  return best
}

/** 命中位置前后各留 80 个字符，超出加省略号；换行压成空格，保证 snippet 单行。 */
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT)
  const end = Math.min(text.length, index + length + SNIPPET_CONTEXT)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** 模型给的 limit 可能是小数、负数或超上限；夹到 [min, max]，缺省用 fallback。 */
function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * 解析 turns 参数：缺省或 all 表示全部，last:N 取最近 N 轮，
 * 其余按逗号分隔的轮次与区间处理（1,3,5-8）。区间不展开，避免 1-999999 占满内存。
 */
function parseTurnSelection(spec: string | undefined): TurnSelection {
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (text === '' || /^all$/i.test(text)) {
    return { kind: 'all' }
  }
  const last = /^last\s*[:：]\s*(\d+)$/i.exec(text)
  if (last !== null) {
    const count = Number(last[1])
    if (count < 1) {
      throw new Error('last:N 的 N 至少为 1')
    }
    return { kind: 'last', count }
  }
  const ranges: Array<{ from: number; to: number }> = []
  for (const part of text.split(/[,，、]/)) {
    const item = part.trim()
    if (item === '') {
      continue
    }
    const range = /^(\d+)\s*[-~—到]\s*(\d+)$/.exec(item)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      ranges.push({ from: Math.min(from, to), to: Math.max(from, to) })
      continue
    }
    if (/^\d+$/.test(item)) {
      const turn = Number(item)
      ranges.push({ from: turn, to: turn })
      continue
    }
    throw new Error(`无法解析轮次范围：${item}（示例：all、last:20、1,3,5-8）`)
  }
  if (ranges.length === 0) {
    throw new Error('轮次范围为空（示例：all、last:20、1,3,5-8）')
  }
  return { kind: 'ranges', ranges }
}

/** 按轮次选择挑出要检索的轮次；结果保持会话顺序，便于模型顺序阅读。 */
function selectTurns(turns: ConversationTurn[], selection: TurnSelection): ConversationTurn[] {
  if (selection.kind === 'all') {
    return turns
  }
  if (selection.kind === 'last') {
    return turns.slice(-selection.count)
  }
  return turns.filter((turn) =>
    selection.ranges.some((range) => turn.turn >= range.from && turn.turn <= range.to)
  )
}

/**
 * 在本会话里搜索消息，返回 JSON 字符串。
 * total 是命中消息总数，matches 只保留前 limit 条，matchedTurns 汇总全部有命中的轮次。
 */
export function searchConversation(messages: Message[], args: SearchArgs): string {
  const query = typeof args?.query === 'string' ? args.query : ''
  if (query.trim() === '') {
    throw new Error('请提供要查找的文字（query）；regex 模式同样需要 query')
  }
  const regex = args?.regex === true
  const includeToolResults = args?.includeToolResults === true
  const limit = clampInteger(args?.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
  const patterns = createPatterns(query, regex)
  const selected = selectTurns(groupTurns(messages), parseTurnSelection(args?.turns))

  let total = 0
  const matchedTurns = new Set<number>()
  const matches: SearchMatch[] = []
  for (const turn of selected) {
    for (const message of turn.messages) {
      // 空正文（例如只有思考块或只有工具块）没有可检索的文字，直接跳过。
      const text = messageText(message, includeToolResults)
      if (text.length === 0) {
        continue
      }
      const found = findMatch(text, patterns)
      if (found === undefined) {
        continue
      }
      total += 1
      matchedTurns.add(turn.turn)
      if (matches.length < limit) {
        matches.push({
          turn: turn.turn,
          messageId: message.id,
          role: message.role,
          snippet: snippetAround(text, found.index, found[0].length),
        })
      }
    }
  }
  return JSON.stringify(
    {
      total,
      matchedTurns: [...matchedTurns].sort((left, right) => left - right),
      matches,
    },
    null,
    1
  )
}

/** 轮次参数可能被模型写成字符串或小数；缺失返回 undefined，非法值直接报错。 */
function parseTurnNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('turn、turnFrom、turnTo 必须是非负整数')
  }
  return Math.floor(number)
}

/**
 * 按参数挑轮次：turn 单轮、turnFrom/turnTo 区间、messageId 单条消息，
 * 都没给时读最后一轮。与参考实现一致，turn 优先于 messageId；越界返回空数组。
 */
function selectReadTurns(turns: ConversationTurn[], args: ReadArgs): ConversationTurn[] {
  const single = parseTurnNumber(args?.turn)
  if (single !== undefined) {
    return turns.filter((turn) => turn.turn === single)
  }
  const from = parseTurnNumber(args?.turnFrom)
  const to = parseTurnNumber(args?.turnTo)
  if (from !== undefined || to !== undefined) {
    const start = Math.min(from ?? to ?? 0, to ?? from ?? 0)
    const end = Math.max(from ?? to ?? 0, to ?? from ?? 0)
    if (end - start + 1 > MAX_READ_TURNS) {
      throw new Error(`一次最多读取 ${MAX_READ_TURNS} 轮，请缩小 turnFrom/turnTo 范围`)
    }
    return turns.filter((turn) => turn.turn >= start && turn.turn <= end)
  }
  const messageId = typeof args?.messageId === 'string' ? args.messageId : ''
  if (messageId !== '') {
    for (const turn of turns) {
      const found = turn.messages.filter((message) => message.id === messageId)
      if (found.length > 0) {
        return [{ turn: turn.turn, messages: found }]
      }
    }
    return []
  }
  const last = turns.at(-1)
  return last === undefined ? [] : [last]
}

/**
 * 按轮次读取消息正文，返回 JSON 字符串。
 * 助手 content 是所有 text 块的拼接（忽略思考与工具块），用户 content 附上附件占位。
 */
export function readConversation(messages: Message[], args: ReadArgs): string {
  const turns = selectReadTurns(groupTurns(messages), args)
  return JSON.stringify(
    {
      turns: turns.map((turn) => ({
        turn: turn.turn,
        messages: turn.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: messageText(message, false),
        })),
      })),
    },
    null,
    1
  )
}
