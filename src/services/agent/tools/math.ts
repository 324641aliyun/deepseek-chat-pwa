// 受限算术文法：只解析数字、运算符和下面这张固定函数表，不执行 JavaScript、不看对象属性，也没有 I/O。

/** 允许调用的函数；白名单之外的名字（包括 max、min）一律按非法表达式处理。 */
const FUNCTIONS = new Map<string, (value: number) => number>([
  ['sqrt', Math.sqrt],
  ['abs', Math.abs],
  ['sin', Math.sin],
  ['cos', Math.cos],
  ['tan', Math.tan],
  ['log', Math.log],
  ['log10', Math.log10],
  ['exp', Math.exp],
  ['floor', Math.floor],
  ['ceil', Math.ceil],
  ['round', Math.round],
])

/**
 * 二元运算符的优先级。这里用 Map 而不是对象字面量，是因为对象字面量会把
 * constructor、toString 这类标识符从原型链上取出来，误当成运算符放行。
 */
const PRECEDENCE = new Map<string, number>([
  ['+', 1],
  ['-', 1],
  ['*', 2],
  ['/', 2],
  ['%', 2],
  ['^', 4],
  ['**', 4],
])

/** 幂的优先级；一元正负号按它下面一级解析，所以 -2^2 等于 -(2^2)。 */
const POWER_PRECEDENCE = 4

/** 字符数、词法单元和嵌套深度的上限，保证单次调用在浏览器里很快返回。 */
const MAX_CHARACTERS = 2048
const MAX_TOKENS = 512
const MAX_DEPTH = 64

/**
 * 词法单元：数字可带小数和指数；标识符留给语法分析判断是常量还是函数名。
 * 标识符允许数字（参考实现只收字母），否则 log10 会被拆成 log + 10 而永远调不到。
 */
const TOKEN_PATTERN =
  /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d+))?|([a-zA-Z_][a-zA-Z0-9_]*)|(\*\*|[+\-*/%^(),]))/y

/**
 * 拆分表达式。数字和指数部分在这里就合成数值（例如 1e3），
 * 标识符和运算符原样留在数组里。
 */
function tokenize(source: string): Array<number | string> {
  const tokens: Array<number | string> = []
  let offset = 0
  while (offset < source.length && source.slice(offset).trim() !== '') {
    TOKEN_PATTERN.lastIndex = offset
    const match = TOKEN_PATTERN.exec(source)
    if (match === null) {
      throw new Error('只允许算术表达式：数字、+ - * / % ^ ** ( ) 和受支持的函数名')
    }
    if (match[1] !== undefined) {
      tokens.push(Number(match[1] + (match[2] ?? '')))
    } else {
      tokens.push(match[3] ?? match[4] ?? '')
    }
    offset = TOKEN_PATTERN.lastIndex
  }
  return tokens
}

/** 计算一个受限算术表达式，返回有限的数值结果。 */
export function calculate(source: string): number {
  // 参数来自模型的 function calling，运行时可能是任意值，所以先按不可信输入校验。
  if (typeof source !== 'string') {
    throw new Error('表达式必须是字符串')
  }
  if (source.length > MAX_CHARACTERS) {
    throw new Error(`表达式最多 ${MAX_CHARACTERS} 个字符`)
  }
  const tokens = tokenize(source)
  if (tokens.length > MAX_TOKENS) {
    throw new Error(`表达式过于复杂（最多 ${MAX_TOKENS} 个词法单元）`)
  }

  let index = 0
  let depth = 0

  /**
   * 递归下降求值。min 是当前层接受的最低优先级：低于它的运算符留给外层处理，
   * 于是优先级和结合性都由 PRECEDENCE 决定，不必给每一级各写一个函数。
   */
  const parse = (min = 0): number => {
    if (++depth > MAX_DEPTH) {
      throw new Error(`表达式嵌套超过 ${MAX_DEPTH} 层`)
    }
    const token = tokens[index++]
    let value: number
    if (typeof token === 'number') {
      value = token
    } else if (token === '+' || token === '-') {
      // 一元正负号比乘除紧、比幂松：-2*3 得 -6，-2^2 得 -4，与常见数学写法一致。
      value = (token === '-' ? -1 : 1) * parse(POWER_PRECEDENCE - 1)
    } else if (token === '(') {
      value = parse()
      if (tokens[index++] !== ')') {
        throw new Error('缺少右括号')
      }
    } else if (token === 'pi') {
      value = Math.PI
    } else if (token === 'e') {
      value = Math.E
    } else {
      const fn = typeof token === 'string' ? FUNCTIONS.get(token) : undefined
      if (fn === undefined) {
        throw new Error('此处需要数字、pi/e、括号或受支持的函数')
      }
      if (tokens[index++] !== '(') {
        throw new Error('函数名后需要括号参数')
      }
      value = fn(parse())
      if (tokens[index++] !== ')') {
        throw new Error('缺少右括号')
      }
    }
    for (;;) {
      const operator = tokens[index]
      if (typeof operator !== 'string') {
        break
      }
      const precedence = PRECEDENCE.get(operator)
      if (precedence === undefined || precedence < min) {
        break
      }
      index++
      // 幂右结合（右侧仍可接幂），其余左结合（右侧只收更高优先级）。
      const right = parse(precedence + (precedence === POWER_PRECEDENCE ? 0 : 1))
      if (operator === '+') {
        value += right
      } else if (operator === '-') {
        value -= right
      } else if (operator === '*') {
        value *= right
      } else if (operator === '/') {
        value /= right
      } else if (operator === '%') {
        value %= right
      } else {
        value **= right
      }
      if (!Number.isFinite(value)) {
        throw new Error('中间结果不是有限数')
      }
    }
    depth--
    return value
  }

  const result = parse()
  if (index !== tokens.length) {
    throw new Error('表达式不完整或存在多余内容')
  }
  if (!Number.isFinite(result)) {
    throw new Error('结果不是有限数')
  }
  return result
}
