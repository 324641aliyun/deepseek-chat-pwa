// 离线验收 math.ts 与 conversation.ts：只用 Node 内置的 type stripping，不引入测试框架。
// 运行：node --experimental-strip-types app\tools\test-agent-tools.mjs（在仓库根目录执行）
import assert from 'node:assert/strict'
import { calculate } from '../src/services/agent/tools/math.ts'
import { readConversation, searchConversation } from '../src/services/agent/tools/conversation.ts'

let passed = 0
const failures = []

function test(name, run) {
  try {
    run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`fail  ${name}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/** 工具结果约定是 JSON 字符串，断言前先解析。 */
function parse(value) {
  assert.equal(typeof value, 'string', '工具结果必须是字符串')
  return JSON.parse(value)
}

const near = (actual, expected, epsilon = 1e-12) => {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} 应接近 ${expected}`)
}

// 会话夹具：三位用户依次提问，助手回答里带多个 text 块、思考块和客户端工具块。
const text = (value) => ({ type: 'text', text: value })
const thinking = (value) => ({ type: 'thinking', thinking: value })
const clientTool = (overrides = {}) => ({
  type: 'client_tool',
  name: 'read_file',
  input: { path: '/var/log/orion.log' },
  status: 'done',
  result: 'needle-tool 里发现 3 处错误',
  isError: false,
  ...overrides,
})
const user = (id, content, names = []) => ({
  id,
  role: 'user',
  content,
  createdAt: 1,
  files: names.map((name) => ({
    id: `file-${name}`,
    serverId: null,
    name,
    size: 10,
    isImage: false,
    mimeType: 'text/plain',
  })),
})
const assistant = (id, blocks) => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: false,
  status: 'done',
  blocks,
})

const conversation = [
  user('u1', '第一轮：项目代号 Orion，部署在东京。'),
  assistant('a1', [
    text('收到。'),
    text('Orion 部署在东京。'),
    thinking('needle-thinking 不应被检索'),
  ]),
  user('u2', '第二轮：Orion 的日志在哪？', ['logs.txt']),
  assistant('a2', [text('日志在 /var/log/orion.log。'), clientTool()]),
  user('u3', '第三轮：确认收到。'),
  assistant('a3', [text('确认收到，Orion 一切正常。')]),
]

section('math.ts：四则运算、优先级、结合性')
test('加减乘除与优先级', () => {
  assert.equal(calculate('1 + 2 * 3'), 7)
  assert.equal(calculate('(1 + 2) * 3'), 9)
  assert.equal(calculate('2 + 3 * 4 ^ 2'), 50)
  assert.equal(calculate('10 % 3'), 1)
})
test('左结合与幂的右结合', () => {
  assert.equal(calculate('10 - 3 - 2'), 5)
  assert.equal(calculate('100 / 10 / 2'), 5)
  assert.equal(calculate('2 ** 3 ** 2'), 512)
  assert.equal(calculate('2^2^3'), 256)
  assert.equal(calculate('2 ^ 10'), 1024)
})
test('一元正负号的优先级', () => {
  assert.equal(calculate('-2 ^ 2'), -4)
  assert.equal(calculate('-2 * 3'), -6)
  assert.equal(calculate('2**-3'), 0.125)
  near(calculate('-(2 + 3)'), -5)
})
test('数字写法：小数、指数、空白', () => {
  assert.equal(calculate('  2*3  '), 6)
  assert.equal(calculate('.5 + 1.'), 1.5)
  assert.equal(calculate('1e3'), 1000)
  near(calculate('1e-5'), 1e-5)
  assert.equal(calculate('1.5e2 / 3'), 50)
})

section('math.ts：常量与函数')
test('pi 与 e', () => {
  near(calculate('pi'), Math.PI)
  near(calculate('e'), Math.E)
  near(calculate('2*pi'), 2 * Math.PI)
})
test('白名单函数', () => {
  assert.equal(calculate('sqrt(16) + abs(-3)'), 7)
  assert.equal(calculate('round(2.5) + floor(2.9) + ceil(2.1)'), 8)
  near(calculate('log(e)'), 1)
  near(calculate('log10(1000)'), 3)
  near(calculate('exp(0)'), 1)
  near(calculate('sin(0)'), 0)
  near(calculate('cos(0)'), 1)
  near(calculate('tan(0)'), 0)
  near(calculate('sqrt(abs(-9))'), 3)
})

section('math.ts：上限')
test('嵌套 63 层可用，64 层报错', () => {
  assert.equal(calculate(`${'('.repeat(63)}1${')'.repeat(63)}`), 1)
  assert.throws(() => calculate(`${'('.repeat(64)}1${')'.repeat(64)}`), /嵌套超过 64 层/)
})
test('511 个词法单元可用，超出报错', () => {
  assert.equal(calculate(`1${'+1'.repeat(255)}`), 256)
  assert.throws(() => calculate(`1${'+1'.repeat(300)}`), /最多 512 个词法单元/)
})
test('2048 字符上限', () => {
  assert.throws(() => calculate('1+1'.repeat(683)), /最多 2048 个字符/)
  near(calculate(' '.repeat(2047) + '1'), 1)
})
test('非字符串参数报错', () => {
  assert.throws(() => calculate(42), /必须是字符串/)
  assert.throws(() => calculate(null), /必须是字符串/)
})

section('math.ts：非法输入')
test('空表达式与不完整表达式', () => {
  assert.throws(() => calculate(''), /此处需要数字/)
  assert.throws(() => calculate('   '), /此处需要数字/)
  assert.throws(() => calculate('1 +'), /此处需要数字/)
  assert.throws(() => calculate('-'), /此处需要数字/)
  assert.throws(() => calculate('()'), /此处需要数字/)
})
test('括号不配对', () => {
  assert.throws(() => calculate('sqrt(4'), /缺少右括号/)
  assert.throws(() => calculate('(1 + 2'), /缺少右括号/)
  assert.throws(() => calculate('sin(1'), /缺少右括号/)
})
test('非法字符与多余内容', () => {
  assert.throws(() => calculate('1 $ 2'), /只允许算术表达式/)
  assert.throws(() => calculate('2{3}'), /只允许算术表达式/)
  assert.throws(() => calculate('1 2'), /多余内容/)
  assert.throws(() => calculate('2(3)'), /多余内容/)
  assert.throws(() => calculate('sqrt(4)2'), /多余内容/)
  assert.throws(() => calculate('(1+2))'), /多余内容/)
})
test('不支持的函数与标识符按非法处理', () => {
  assert.throws(() => calculate('max(1, 2)'), /此处需要数字/)
  assert.throws(() => calculate('abc'), /此处需要数字/)
  assert.throws(() => calculate('sqrt 4'), /函数名后需要括号参数/)
  // 对象字面量会从原型链上取到 constructor / toString，这里必须仍然报错。
  assert.throws(() => calculate('1 constructor 2'), /多余内容/)
  assert.throws(() => calculate('1 toString 2'), /多余内容/)
})
test('非有限结果报错', () => {
  assert.throws(() => calculate('1/0'), /不是有限数/)
  assert.throws(() => calculate('0/0'), /不是有限数/)
  assert.throws(() => calculate('log(0)'), /结果不是有限数/)
  assert.throws(() => calculate('10^1000'), /不是有限数/)
})

section('conversation.ts：关键词检索')
test('大小写不敏感，跨轮次汇总', () => {
  const result = parse(searchConversation(conversation, { query: 'orion' }))
  assert.equal(result.total, 5)
  assert.deepEqual(result.matchedTurns, [1, 2, 3])
  assert.deepEqual(
    result.matches.map((hit) => hit.messageId),
    ['u1', 'a1', 'u2', 'a2', 'a3']
  )
  assert.equal(result.matches[0].role, 'user')
  assert.equal(result.matches[1].role, 'assistant')
  assert.equal(result.matches[0].turn, 1)
  assert.equal(result.matches[3].turn, 2)
})
test('按字面量匹配：a+b 不会命中 aab', () => {
  const literal = [user('l1', '这里只有 aab。'), user('l2', '这里有 a+b。')]
  const result = parse(searchConversation(literal, { query: 'a+b' }))
  assert.equal(result.total, 1)
  assert.deepEqual(
    result.matches.map((hit) => hit.messageId),
    ['l2']
  )
})
test('多个关键词需同时出现', () => {
  const multi = [user('m1', 'alpha 和 beta 都在这里'), user('m2', '只有 alpha')]
  const result = parse(searchConversation(multi, { query: 'alpha   beta' }))
  assert.equal(result.total, 1)
  assert.equal(result.matches[0].messageId, 'm1')
})
test('附件文件名可被搜到', () => {
  const result = parse(searchConversation(conversation, { query: 'logs.txt' }))
  assert.equal(result.total, 1)
  assert.equal(result.matches[0].messageId, 'u2')
  assert.match(result.matches[0].snippet, /\[附件: logs\.txt\]/)
})
test('同一消息多处命中只算一条', () => {
  const repeated = [user('r1', 'needle 和 needle 都在这条消息里')]
  const result = parse(searchConversation(repeated, { query: 'needle' }))
  assert.equal(result.total, 1)
  assert.equal(result.matches.length, 1)
})

section('conversation.ts：正则检索')
test('regex 为 true 时按正则解释', () => {
  const result = parse(searchConversation(conversation, { query: 'orion\\.log', regex: true }))
  assert.equal(result.total, 1)
  assert.equal(result.matches[0].messageId, 'a2')
  assert.equal(result.matches[0].role, 'assistant')
})
test('正则忽略大小写并支持分组', () => {
  const result = parse(searchConversation(conversation, { query: '(ORION|东京)', regex: true }))
  assert.equal(result.total, 5)
})
test('非法正则报错', () => {
  assert.throws(
    () => searchConversation(conversation, { query: '(', regex: true }),
    /正则表达式无效/
  )
})

section('conversation.ts：turns 过滤')
test('last:1 只查最后一轮', () => {
  const result = parse(searchConversation(conversation, { query: 'orion', turns: 'last:1' }))
  assert.equal(result.total, 1)
  assert.deepEqual(result.matchedTurns, [3])
  assert.equal(result.matches[0].messageId, 'a3')
})
test('逗号列表 1,3 排除第 2 轮', () => {
  const result = parse(searchConversation(conversation, { query: 'orion', turns: '1,3' }))
  assert.equal(result.total, 3)
  assert.deepEqual(
    result.matches.map((hit) => hit.messageId),
    ['u1', 'a1', 'a3']
  )
})
test('区间 1-2 含两端', () => {
  const result = parse(searchConversation(conversation, { query: 'orion', turns: '1-2' }))
  assert.equal(result.total, 4)
  assert.deepEqual(result.matchedTurns, [1, 2])
})
test('all 与省略等价', () => {
  const all = parse(searchConversation(conversation, { query: 'orion', turns: 'all' }))
  const none = parse(searchConversation(conversation, { query: 'orion' }))
  assert.deepEqual(all, none)
})
test('turns 语法错误报错', () => {
  assert.throws(
    () => searchConversation(conversation, { query: 'orion', turns: 'bogus' }),
    /无法解析轮次范围/
  )
  assert.throws(
    () => searchConversation(conversation, { query: 'orion', turns: 'last:0' }),
    /至少为 1/
  )
})

section('conversation.ts：snippet 截断')
test('命中前后各 80 字符，两侧加省略号且单行化', () => {
  const longText = `${'A'.repeat(200)}needle${'B'.repeat(200)}`
  const result = parse(searchConversation([user('s1', longText)], { query: 'needle' }))
  const snippet = result.matches[0].snippet
  assert.equal(snippet, `…${'A'.repeat(80)}needle${'B'.repeat(80)}…`)
  assert.equal(snippet.length, 168)
})
test('换行压成空格', () => {
  const source = `line1\nline2 ${'x'.repeat(100)}\nneedle\n${'y'.repeat(100)}`
  const result = parse(searchConversation([user('s2', source)], { query: 'needle' }))
  const snippet = result.matches[0].snippet
  assert.ok(snippet.includes('needle'))
  assert.ok(!snippet.includes('\n'), 'snippet 必须单行')
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'))
})
test('短消息不加省略号', () => {
  const result = parse(searchConversation([user('s3', '简短 needle 文本')], { query: 'needle' }))
  assert.equal(result.matches[0].snippet, '简短 needle 文本')
})

section('conversation.ts：includeToolResults')
test('默认不检索工具结果', () => {
  const result = parse(searchConversation(conversation, { query: 'needle-tool' }))
  assert.equal(result.total, 0)
  assert.deepEqual(result.matches, [])
  assert.deepEqual(result.matchedTurns, [])
})
test('打开后检索工具结果', () => {
  const result = parse(
    searchConversation(conversation, { query: 'needle-tool', includeToolResults: true })
  )
  assert.equal(result.total, 1)
  assert.equal(result.matches[0].messageId, 'a2')
  assert.equal(result.matches[0].role, 'assistant')
  assert.match(result.matches[0].snippet, /\[工具 read_file\]/)
  assert.match(result.matches[0].snippet, /状态: done/)
})
test('思考块始终不参与检索', () => {
  const result = parse(
    searchConversation(conversation, { query: 'needle-thinking', includeToolResults: true })
  )
  assert.equal(result.total, 0)
})

section('conversation.ts：limit')
test('默认 20 条、最多 50 条', () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    user(`n${index + 1}`, `needle ${index + 1}`)
  )
  const fallback = parse(searchConversation(many, { query: 'needle' }))
  assert.equal(fallback.total, 60)
  assert.equal(fallback.matches.length, 20)
  assert.equal(fallback.matches[0].messageId, 'n1')
  const capped = parse(searchConversation(many, { query: 'needle', limit: 1000 }))
  assert.equal(capped.matches.length, 50)
  const small = parse(searchConversation(many, { query: 'needle', limit: 2 }))
  assert.equal(small.total, 60)
  assert.equal(small.matches.length, 2)
})
test('last:20 取最近二十轮', () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    user(`n${index + 1}`, `needle ${index + 1}`)
  )
  const result = parse(searchConversation(many, { query: 'needle', turns: 'last:20' }))
  assert.equal(result.total, 20)
  assert.deepEqual(
    result.matchedTurns,
    Array.from({ length: 20 }, (_, index) => index + 41)
  )
})

section('conversation.ts：缺少 query')
test('没有 query 时抛错', () => {
  assert.throws(() => searchConversation(conversation, {}), /请提供要查找的文字/)
  assert.throws(() => searchConversation(conversation, { turns: 'last:1' }), /请提供要查找的文字/)
  assert.throws(() => searchConversation(conversation, { query: '   ' }), /请提供要查找的文字/)
})

section('conversation.ts：readConversation')
test('默认读最后一轮', () => {
  const result = parse(readConversation(conversation, {}))
  assert.equal(result.turns.length, 1)
  assert.equal(result.turns[0].turn, 3)
  assert.deepEqual(
    result.turns[0].messages.map((message) => message.id),
    ['u3', 'a3']
  )
  assert.equal(result.turns[0].messages[1].role, 'assistant')
  assert.equal(result.turns[0].messages[1].content, '确认收到，Orion 一切正常。')
})
test('turn 读单轮，助手正文拼接所有 text 块并忽略思考', () => {
  const result = parse(readConversation(conversation, { turn: 1 }))
  assert.equal(result.turns.length, 1)
  assert.equal(result.turns[0].turn, 1)
  assert.equal(result.turns[0].messages[0].content, '第一轮：项目代号 Orion，部署在东京。')
  assert.equal(result.turns[0].messages[1].content, '收到。\nOrion 部署在东京。')
  assert.ok(!result.turns[0].messages[1].content.includes('needle-thinking'))
})
test('用户附件追加在正文后，助手工具块不进入正文', () => {
  const result = parse(readConversation(conversation, { turn: 2 }))
  assert.equal(result.turns[0].messages[0].content, '第二轮：Orion 的日志在哪？\n[附件: logs.txt]')
  assert.equal(result.turns[0].messages[1].content, '日志在 /var/log/orion.log。')
})
test('turnFrom/turnTo 读区间，含端点', () => {
  const result = parse(readConversation(conversation, { turnFrom: 1, turnTo: 2 }))
  assert.deepEqual(
    result.turns.map((turn) => turn.turn),
    [1, 2]
  )
  assert.deepEqual(
    result.turns.map((turn) => turn.messages.length),
    [2, 2]
  )
})
test('只给 turnFrom 时按单轮处理', () => {
  const result = parse(readConversation(conversation, { turnFrom: 2 }))
  assert.deepEqual(
    result.turns.map((turn) => turn.turn),
    [2]
  )
})
test('只给 turnTo 时也按单轮处理', () => {
  const result = parse(readConversation(conversation, { turnTo: 2 }))
  assert.deepEqual(
    result.turns.map((turn) => turn.turn),
    [2]
  )
})
test('区间只返回存在的轮次', () => {
  const result = parse(readConversation(conversation, { turnFrom: 3, turnTo: 9 }))
  assert.deepEqual(
    result.turns.map((turn) => turn.turn),
    [3]
  )
})
test('messageId 读单条消息', () => {
  const result = parse(readConversation(conversation, { messageId: 'a2' }))
  assert.deepEqual(result.turns, [
    {
      turn: 2,
      messages: [{ id: 'a2', role: 'assistant', content: '日志在 /var/log/orion.log。' }],
    },
  ])
})
test('越界轮次与不存在的 messageId 返回空数组', () => {
  assert.deepEqual(parse(readConversation(conversation, { turn: 99 })).turns, [])
  assert.deepEqual(parse(readConversation(conversation, { messageId: 'nope' })).turns, [])
})
test('会话为空时读最后一轮返回空数组', () => {
  assert.deepEqual(parse(readConversation([], {})).turns, [])
})
test('区间超过 50 轮报错', () => {
  assert.throws(() => readConversation(conversation, { turnFrom: 1, turnTo: 60 }), /最多读取 50 轮/)
})
test('连续的用户消息各自开启新轮', () => {
  const consecutive = [user('c1', '一'), user('c2', '二'), assistant('c3', [text('答')])]
  const first = parse(readConversation(consecutive, { turn: 1 }))
  assert.deepEqual(
    first.turns[0].messages.map((message) => message.id),
    ['c1']
  )
  const second = parse(readConversation(consecutive, { turn: 2 }))
  assert.deepEqual(
    second.turns[0].messages.map((message) => message.id),
    ['c2', 'c3']
  )
})
test('用户消息之前的助手消息归入第 0 轮', () => {
  const orphan = [assistant('x1', [text('孤立回答')])]
  const result = parse(readConversation(orphan, {}))
  assert.equal(result.turns[0].turn, 0)
  assert.equal(result.turns[0].messages[0].content, '孤立回答')
})

section('结果')
console.log(`\n${passed} passed, ${failures.length} failed`)
for (const failure of failures) {
  console.log(`\n失败：${failure.name}`)
  console.log(failure.error instanceof Error ? failure.error.stack : String(failure.error))
}
if (failures.length > 0) {
  process.exitCode = 1
}
