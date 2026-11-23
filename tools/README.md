# 会话工具模块测试

`test-agent-tools.mjs` 是 [math.ts](../src/services/agent/tools/math.ts) 与 [conversation.ts](../src/services/agent/tools/conversation.ts) 的离线测试。它用 Node 内置的类型擦除直接跑 `.ts` 文件，不引入测试框架，也不需要浏览器、构建或额外依赖。

## 运行

在仓库根目录（包含 `app/` 的那一层）执行：

```text
node --experimental-strip-types app\tools\test-agent-tools.mjs
```

Node 24 可用；类型擦除在 Node 24 里默认开启，参数保留下来是为了兼容旧版本。测试直接 import `../src/services/agent/tools/math.ts` 这类带 `.ts` 后缀的路径，Node 擦掉类型后按 ESM 执行。

## 覆盖范围

- `calculate`：四则运算与优先级、左结合与幂的右结合、一元正负号、小数/指数/空白写法、`pi` 与 `e`、12 个白名单函数，以及 2048 字符 / 512 词法单元 / 64 层嵌套三个上限；空表达式、括号不配对、非法字符、不支持的函数、非有限结果各自报错。
- `searchConversation`：关键词（按字面量、大小写不敏感、多词需同时出现）、正则（含非法正则）、`turns` 的 `all` / `last:N` / `1,3,5-8` 三种写法、`limit` 默认 20 与上限 50、`includeToolResults` 开关、snippet 前后各 80 字符与单行化、缺少 query 报错。
- `readConversation`：`turn` 单轮、`turnFrom`/`turnTo` 区间（含端点，缺一端按单轮）、`messageId` 单条、都不给读最后一轮、越界返回空数组、区间超过 50 轮报错、连续用户消息各自开启新轮、助手正文只拼接 text 块。

## 最近一次结果

2026-11-23T11:32+09:00 (Asia/Tokyo)，在仓库根执行：

```text
$ node --experimental-strip-types app\tools\test-agent-tools.mjs
...
50 passed, 0 failed
```

耗时约 0.2 秒，退出码 0。失败时脚本逐条打印失败的断言与堆栈，并以退出码 1 结束。

## 行为约定

- 两个函数都返回 JSON 字符串，使用 1 空格缩进，方便直接作为工具结果阅读；`total`、`matchedTurns` 这类汇总字段保证模型不用翻完所有命中就能判断范围。
- 轮次从第 1 条用户消息开始编号；连续的用户消息各自开启一轮；用户消息之前的助手消息（导入数据里可能出现）归入第 0 轮，不静默丢弃。
- 关键词按空白拆成多个词、全部出现才算命中，与参考实现一致；正则不带 `g` 标志，连续调用互不影响。
- `searchConversation` 按会话顺序（旧到新）返回命中：`total` 是命中消息总数，`matches` 只保留前 `limit` 条，`matchedTurns` 汇总全部有命中的轮次。同一消息多处命中只记一条，snippet 取该消息内最长的一处。
- `readConversation` 不截断正文；会话很长时建议按 `turn` 或区间分段读取。

## 与参考实现的差异

- 参考实现的词法单元只收字母，`log10` 会被拆成 `log` + `10` 而永远解析不到；这里允许标识符带数字，`log10` 可用。
- 参考实现用对象字面量查运算符优先级，`1 constructor 2` 会从原型链取到构造函数而静默返回 1；这里改用 `Map`，这类标识符按非法表达式报错。
