import { streamMessage } from '../api/client.js'
import type { ChatModel, MessageParam } from '../api/types.js'
import type { AssistantMessage, Checkpoint, Message, UserMessage } from '../chat/types.js'

/**
 * 长对话压缩：接近上下文窗口时，把较早的轮次摘要成一条检查点，最近若干轮原样保留。
 * 原始消息不删除，只改变「发给模型的上下文」从哪里开始，所以会话检索仍然能查到旧内容。
 */

/** deepseek-flash 的上下文预算；按官方 98K 档预留，避免把窗口顶满才发现 */
export const CONTEXT_WINDOW_TOKENS = 96_000
/** 触发自动压缩的占用比例 */
export const COMPACT_TRIGGER_RATIO = 0.75
/** 压缩后备答保留的最近轮数（逐字保留） */
export const KEEP_RECENT_TURNS = 20
/** 单次摘要请求的输入预算，超过就分块摘要 */
const CHUNK_TOKENS = 24_000
/** 摘要请求的输出上限 */
const SUMMARY_MAX_TOKENS = 2_048
/** 总结请求最多尝试次数（分块摘要时也用它限制重试） */
const SUMMARY_ATTEMPTS = 3

/** 中文按 1 字 1 token、其他字符按 4 字符 1 token 估算，宁可高估 */
export const estimateTextTokens = (text: string): number => {
  let cjk = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    // CJK 统一表意文字、全角标点、假名与谚文
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

export const estimateMessagesTokens = (messages: MessageParam[]): number =>
  messages.reduce((total, message) => {
    if (typeof message.content === 'string') {
      return total + estimateTextTokens(message.content) + 4
    }
    return (
      total +
      message.content.reduce((sum, block) => {
        const record = block as { text?: string; thinking?: string; kind?: string }
        if (typeof record.text === 'string') {
          return sum + estimateTextTokens(record.text)
        }
        if (typeof record.thinking === 'string') {
          return sum + estimateTextTokens(record.thinking)
        }
        return sum + 40
      }, 4)
    )
  }, 0)

/** 一轮 = 一条用户消息 + 它后面那条可用的助手回复 */
export type Turn = { user: UserMessage; reply?: Message; userIndex: number }

export const splitTurns = (history: Message[]): Turn[] => {
  const turns: Turn[] = []
  history.forEach((message, index) => {
    if (message.role === 'user') {
      turns.push({ user: message, userIndex: index })
      return
    }
    const current = turns.at(-1)
    if (current && !current.reply) {
      current.reply = message
    }
  })
  return turns
}

const replyText = (reply: Message | undefined): string => {
  if (!reply || reply.role !== 'assistant') {
    return ''
  }
  const assistant = reply as AssistantMessage
  return assistant.blocks
    .map((block) => {
      if (block.type === 'text') {
        return block.text
      }
      if (block.type === 'client_tool') {
        const args = JSON.stringify(block.input)
        const result = block.result ?? ''
        const clipped = result.length > 600 ? `${result.slice(0, 600)}…` : result
        return `[工具 ${block.name} ${args} ⇒ ${clipped}]`
      }
      if (block.type === 'server_tool_use') {
        return `[服务端工具 ${block.name}：${JSON.stringify(block.input)}]`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 把若干轮转成摘要请求的输入文本，工具输出按 600 字截断，控制摘要请求本身的体量 */
export const buildTranscript = (turns: Turn[], offset = 1): string =>
  turns
    .map((turn, index) => {
      const files = turn.user.files.map((file) => file.name).join('、')
      const body = [
        `用户：${turn.user.content || '（仅附件）'}`,
        files ? `附件：${files}` : null,
        replyText(turn.reply) ? `助手：${replyText(turn.reply)}` : null,
      ]
        .filter(Boolean)
        .join('\n')
      return `— 第 ${offset + index} 轮 —\n${body}`
    })
    .join('\n\n')

const SUMMARY_SYSTEM = [
  '你是对话压缩器。把给定的对话压缩成一份检查点，供后续继续同一话题时使用。',
  '保留：用户的目标与约束、已经确认的事实与结论、关键数据、链接、仍然待办的事项。',
  '删除：寒暄、重复表述、已经作废的中间过程。',
  '用简洁的中文条目式输出；不要添加对话里没有的信息；不超过 1200 字。',
].join('\n')

const summarizeOnce = async (
  apiKey: string,
  model: ChatModel,
  content: string,
  signal: AbortSignal
): Promise<string> => {
  let text = ''
  const events = streamMessage(
    apiKey,
    {
      model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content }],
      thinking: { type: 'disabled' },
      tools: [],
      safety_check: { level: 'high' },
      max_tokens: SUMMARY_MAX_TOKENS,
    },
    signal
  )
  for await (const event of events) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('摘要结果为空')
  }
  return trimmed
}

/** 分块摘要后再合并：历史本身已经超过窗口时，单次摘要请求也会超窗 */
const summarize = async (
  options: { apiKey: string; model: ChatModel; signal: AbortSignal },
  transcript: string
): Promise<string> => {
  const { apiKey, model, signal } = options
  let lastError: unknown
  for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt++) {
    try {
      if (estimateTextTokens(transcript) <= CHUNK_TOKENS) {
        return await summarizeOnce(apiKey, model, `${transcript}\n\n请输出检查点摘要。`, signal)
      }
      const blocks = transcript.split(/\n\n(?=— 第 )/)
      const chunks: string[] = []
      let current = ''
      for (const block of blocks) {
        if (current && estimateTextTokens(`${current}\n\n${block}`) > CHUNK_TOKENS) {
          chunks.push(current)
          current = block
        } else {
          current = current ? `${current}\n\n${block}` : block
        }
      }
      if (current) {
        chunks.push(current)
      }
      const partials: string[] = []
      for (const chunk of chunks) {
        partials.push(
          await summarizeOnce(apiKey, model, `${chunk}\n\n请只摘要这一段对话。`, signal)
        )
      }
      return await summarizeOnce(
        apiKey,
        model,
        `以下是同一段长对话分段摘要，请合并成一份检查点，去掉重复、保留顺序与结论：\n\n${partials.join('\n\n')}`,
        signal
      )
    } catch (error) {
      lastError = error
      if (signal.aborted || attempt === SUMMARY_ATTEMPTS - 1) {
        throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('摘要失败')
}

export type CompactionPlan = {
  /** 要摘要的轮次 */
  turns: Turn[]
  /** 摘要覆盖到的最后一条消息 id */
  coveredUpTo: string
  /** 摘要覆盖的轮数（从第 1 轮起算） */
  turnsCount: number
}

/**
 * 选出要压缩的前缀轮次：保留最近 keepRecent 轮，剩下的整轮压缩。
 * 没有可压缩的轮次时返回 null。
 */
export const planCompaction = (
  history: Message[],
  keepRecent = KEEP_RECENT_TURNS
): CompactionPlan | null => {
  const turns = splitTurns(history)
  const count = turns.length
  if (count <= keepRecent) {
    return null
  }
  const compacted = turns.slice(0, count - keepRecent)
  const last = compacted.at(-1)
  if (!last) {
    return null
  }
  const coveredUpTo = last.reply?.id ?? last.user.id
  return { turns: compacted, coveredUpTo, turnsCount: compacted.length }
}

/** 摘要一轮压缩；调用方负责写回 session.checkpoint */
export const compactHistory = async (options: {
  apiKey: string
  model: ChatModel
  signal: AbortSignal
  history: Message[]
  keepRecent?: number
}): Promise<Checkpoint | null> => {
  const plan = planCompaction(options.history, options.keepRecent)
  if (!plan) {
    return null
  }
  const transcript = buildTranscript(plan.turns)
  const summary = await summarize(
    { apiKey: options.apiKey, model: options.model, signal: options.signal },
    transcript
  )
  return {
    coveredUpTo: plan.coveredUpTo,
    summary,
    createdAt: Date.now(),
    turns: plan.turnsCount,
  }
}

/** 把检查点摘要拼进 system：不占对话角色位置，也就不影响历史轮次的配对 */
export const withCheckpoint = (system: string, checkpoint: Checkpoint | undefined): string => {
  if (!checkpoint) {
    return system
  }
  const header = checkpoint.turns
    ? `以下是本次对话较早的 ${checkpoint.turns} 轮摘要，作为背景继续对话：`
    : '以下是本次对话较早部分的摘要，作为背景继续对话：'
  return `${system}\n\n${header}\n${checkpoint.summary}`
}
