// 协议层集成测试：不经浏览器，直接验证「流式工具事件 → 回复块 → 请求消息」这条链路。
// 运行：node --experimental-strip-types --import ./tools/register-ts.mjs tools/test-protocol.mjs
import assert from 'node:assert/strict'
import { readMessageEvent } from '../src/services/api/parseEvent.ts'
import {
  applyEvent,
  canContinueReply,
  getPendingToolCalls,
  getToolResults,
  settleReply,
  toRequestMessages,
  toToolAssistantParam,
} from '../src/services/chat/reply.ts'
import {
  estimateTextTokens,
  planCompaction,
  splitTurns,
  withCheckpoint,
} from '../src/services/agent/compaction.ts'

const now = 1_700_000_000_000

// --- 1. 解析层：tool_use 块与 input_json_delta ---------------------------------
{
  const start = readMessageEvent({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call_1', name: 'calculate', input: {} },
  })
  assert.equal(start?.type, 'content_block_start')
  assert.deepEqual(start.content_block, {
    type: 'tool_use',
    id: 'call_1',
    name: 'calculate',
    input: {},
  })

  const delta = readMessageEvent({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"expression":"1+1"}' },
  })
  assert.equal(delta?.delta.type, 'input_json_delta')

  const stop = readMessageEvent({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
  })
  assert.equal(stop?.delta.stop_reason, 'tool_use')

  const garbage = readMessageEvent({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 42, name: 'x' },
  })
  assert.equal(garbage, null)
  console.log('ok 解析层 tool_use / input_json_delta')
}

// --- 2. 归并层：流式事件落成 client_tool 块 -------------------------------------
{
  let reply = {
    id: 'reply-1',
    role: 'assistant',
    createdAt: now,
    model: 'deepseek-flash',
    thinking: true,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
  const indexes = new Map()
  const feed = (event) => {
    reply = applyEvent(reply, event, now, indexes)
  }
  feed(readMessageEvent({ type: 'message_start', message: { id: 'msg', model: 'deepseek-flash' } }))
  feed(readMessageEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }))
  feed(readMessageEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先算一下' } }))
  feed(readMessageEvent({ type: 'content_block_stop', index: 0 }))
  feed(
    readMessageEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call_1', name: 'calculate', input: { expression: '2*3' } },
    })
  )
  feed(readMessageEvent({ type: 'content_block_stop', index: 1 }))
  feed(
    readMessageEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 },
    })
  )
  feed(readMessageEvent({ type: 'message_stop' }))

  assert.equal(reply.blocks.length, 2)
  const tool = reply.blocks[1]
  assert.equal(tool.type, 'client_tool')
  assert.equal(tool.status, 'running')
  assert.deepEqual(tool.input, { expression: '2*3' })
  assert.equal(reply.stopReason, 'tool_use')
  assert.equal(reply.prefix, false)
  assert.deepEqual(getPendingToolCalls(reply.blocks).map((call) => call.id), ['call_1'])
  assert.equal(canContinueReply(settleReply(reply, 'done', now)), false)

  // 执行完成：写入结果后应当能配成 tool_result
  reply.blocks[1] = { ...tool, status: 'done', result: '6', endedAt: now }
  assert.deepEqual(getToolResults(reply), [
    { type: 'tool_result', tool_use_id: 'call_1', content: '6' },
  ])
  console.log('ok 归并层 client_tool / 工具结果配对')
}

// --- 3. 请求层：历史里的工具往返重建为 assistant+user 且角色交替 ------------------
{
  const userTurn = { id: 'u1', role: 'user', content: '2*3 等于几', files: [], createdAt: now }
  const assistantTurn = {
    id: 'a1',
    role: 'assistant',
    createdAt: now,
    model: 'deepseek-flash',
    thinking: true,
    prefix: false,
    status: 'done',
    stopReason: 'end_turn',
    blocks: [
      { type: 'text', text: '我用计算器算一下。' },
      { type: 'client_tool', id: 'call_1', name: 'calculate', input: { expression: '2*3' }, status: 'done', result: '6' },
      { type: 'text', text: '结果是 6。' },
    ],
  }
  const question = { id: 'u2', role: 'user', content: '那 6*7 呢', files: [], createdAt: now + 1 }
  const messages = toRequestMessages([userTurn, assistantTurn], question)
  // 一条本地回复按工具边界拆成 assistant(tool_use) → user(tool_result) → assistant(正文)
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant', 'user']
  )
  assert.deepEqual(
    messages[1].content.map((block) => block.type),
    ['text', 'tool_use']
  )
  assert.equal(messages[1].content.at(-1).id, 'call_1')
  assert.deepEqual(
    messages[2].content.map((block) => block.type),
    ['tool_result']
  )
  assert.equal(messages[2].content[0].tool_use_id, 'call_1')
  assert.deepEqual(
    messages[3].content.map((block) => block.type),
    ['text']
  )
  assert.equal(messages[3].content[0].text, '结果是 6。')
  const last = messages[4]
  assert.equal(typeof last.content, 'string')
  assert.equal(last.content, '那 6*7 呢')

  // 回复停在工具调用上时，结果并入下一条用户消息，不产生连续 user
  const stopAtTool = {
    ...assistantTurn,
    blocks: [
      { type: 'text', text: '我查一下。' },
      { type: 'client_tool', id: 'call_9', name: 'calculate', input: { expression: '1+1' }, status: 'done', result: '2' },
    ],
  }
  const merged = toRequestMessages([userTurn, stopAtTool], question)
  assert.deepEqual(
    merged.map((message) => message.role),
    ['user', 'assistant', 'user']
  )
  assert.deepEqual(
    merged[2].content.map((block) => block.type),
    ['tool_result', 'text']
  )
  assert.equal(merged[2].content[1].text, '那 6*7 呢')

  // 同一轮续传用的 assistant 内容：正文在前，tool_use 必须排在最后
  const roundAssistant = toToolAssistantParam(assistantTurn.blocks)
  assert.deepEqual(roundAssistant.content.map((block) => block.type), ['text', 'text', 'tool_use'])
  console.log('ok 请求层 工具往返重建 + 角色交替')
}

// --- 4. 压缩层：轮次切分、保留最近 N 轮、检查点拼装 ------------------------------
{
  assert.equal(estimateTextTokens('中文四个字'), 5)
  assert.equal(estimateTextTokens('abcd'), 1)

  const history = []
  for (let index = 1; index <= 25; index++) {
    history.push({ id: `u${index}`, role: 'user', content: `问题 ${index}`, files: [], createdAt: index })
    history.push({
      id: `a${index}`,
      role: 'assistant',
      createdAt: index,
      model: 'deepseek-flash',
      prefix: true,
      status: 'done',
      blocks: [{ type: 'text', text: `回答 ${index}` }],
    })
  }
  const turns = splitTurns(history)
  assert.equal(turns.length, 25)
  const plan = planCompaction(history, 20)
  assert.equal(plan.turnsCount, 5)
  assert.equal(plan.coveredUpTo, 'a5')
  assert.equal(planCompaction(history.slice(0, 20), 20), null)

  const system = withCheckpoint('身份说明', { coveredUpTo: 'a5', summary: '前 5 轮的摘要', createdAt: 0, turns: 5 })
  assert.match(system, /身份说明/)
  assert.match(system, /前 5 轮的摘要/)
  console.log('ok 压缩层 轮次与检查点')
}

console.log('\n全部协议层测试通过')
