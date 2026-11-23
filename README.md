# DeepSeek 对话（手机版）

基于 DeepSeek 官方开源聊天客户端 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)（MIT）修改而来：保留官方界面与联网搜索、深度思考、附件、语音、Markdown/KaTeX/Mermaid、历史导入导出等能力，另外把 DSH「基础对话」预设里那套**浏览器内工具调用**合了进来，并做成了可以装到 Android 手机主屏、脱离电脑独立运行的 PWA。

- 线上地址：<https://324641aliyun.github.io/deepseek-chat-pwa/>
- 源码：<https://github.com/324641aliyun/deepseek-chat-pwa>
- 上游项目：<https://github.com/deepseek-ai/chat-demo>
- 本版基于上游 0.1.3（2026-11-23T11:52+09:00 (Asia/Tokyo) 同步）

## 装到手机（Android）

1. 用手机 Chrome 打开 <https://324641aliyun.github.io/deepseek-chat-pwa/>
2. 右上角菜单 → **安装应用 / 添加到主屏幕**
3. 打开后先点右上角设置，把 API Key 填进去（`sk-` 开头，来自 <https://platform.deepseek.com>）
4. 之后从桌面图标进入即可；除模型请求外不需要电脑在线

装好后会以独立窗口运行，有自己的图标；首次打开后即使断网也能加载界面外壳（缓存的是应用本身，聊天记录本来就在本机）。

## 和官方 demo 的差别

**人格与工具**（合并自 DSH「基础对话」预设，但提示词按官方 demo 的写法重写，只用一句话说明身份，再加一段工具使用说明）：

| 能力 | 说明 |
| --- | --- |
| 多轮工具调用 | 模型可以连续多轮思考、调用工具、看结果再决定下一步；单轮最多 8 轮，不会只调一次 |
| `calculate` | 受限算术求值（`+ - * / % ^`、括号、`pi`/`e`、12 个数学函数），不做代码执行 |
| `search_conversation` | 在本会话全部历史里检索（关键词 / 正则 / 指定轮次 / 最近若干轮），**被压缩掉的旧轮次也能查到** |
| `read_conversation` | 按轮次或单条消息读取原文 |
| `read_uploaded_file` | 列出/读取用户在本会话上传的文本附件，上限 2 MiB，只认本会话的上传 |
| `web_fetch` | **可选**：抓取网页正文，需要电脑上跑本地工具服务（见下） |

**上下文**：

- 接近窗口时自动把较早的轮次摘要成检查点，**最近 20 轮逐字保留**；历史本身超窗时分块摘要再合并。
- 输入 `/compact` 立即压缩一次，并给出一条提示。
- 原始消息一条都不删，压缩只影响「发给模型的上下文从哪里开始」，所以检索和界面展示仍是全文。

**设置里新增三项**：工具调用开关（开启后固定使用深度思考——接口要求客户端工具只能在思考模式下用）、自动压缩开关、本地工具服务地址。

## 可选：电脑上的本地工具服务

手机浏览器受跨域限制，读不了别的站点的正文；`web_fetch` 需要电脑上这个零依赖小服务：

```sh
node helper/server.mjs            # 默认 8787 端口
```

然后在手机 App 设置里把「本地工具服务」填成 `http://<电脑局域网 IP>:8787`，两台设备连同一个 Wi-Fi。Windows 首次运行会弹防火墙授权，允许专用网络即可。服务只做两件事：`GET /health` 健康检查、`GET /fetch?url=…` 抓正文；不保存任何内容。

电脑关机或不在同一网络时，这个工具会自动从工具列表里消失，其余功能照常——**手机单独可用是硬要求**，本地服务只是增强。

## 没有移植的部分

- **B 站视频逐帧阅读**：DSH 预设里那个工具要解码 DASH 视频流，浏览器没有 FFmpeg，做不了；做在电脑端又违背「不开电脑也能用」。所以这版没有它。
- DSH 预设里的 `web_search`：官方 demo 自带服务端联网搜索（含边想边搜与来源引用），能力等价，不重复实现。

## 开发

```sh
pnpm install
pnpm dev        # http://localhost:8090
pnpm build      # 产物在 dist/
pnpm type
pnpm lint
```

Windows 上 `dev`/`build` 已改用 `cross-env`（上游脚本用 `rm -rf` 与 `NODE_ENV=` 前缀，cmd 下跑不了）。

### 测试

```sh
# 协议层：流式工具事件 → 回复块 → 请求消息重建（含角色交替、检查点）
node --experimental-transform-types --import ./tools/register-ts.mjs tools/test-protocol.mjs

# 工具层：算术与会话检索（50 条断言）
node --experimental-strip-types tools/test-agent-tools.mjs

# 端到端：真实 Chrome 跑两轮对话，验证同一轮多工具 + 跨轮历史回放
node tools/e2e.mjs
$env:E2E_URL='https://324641aliyun.github.io/deepseek-chat-pwa/'; node tools/e2e.mjs
```

`tools/probe-*.mjs` 是直接打 DeepSeek Anthropic 兼容接口的探针，用来确认客户端工具的流式协议、`tool_use`/`tool_result` 配对规则与历史回放形状；它们会**消耗真实额度**，平时不必跑。

## 数据与隐私

- API Key 与设置存 `localStorage`，会话与附件原件存 IndexedDB，都只在这台设备的浏览器里。
- 对话、附件、语音会提交给 `https://api.deepseek.com`；其余请求不出浏览器。
- 部署在公开的 GitHub Pages 上，但页面本身不含任何密钥；谁打开都要自己填 Key。

## 许可

MIT，沿用上游 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) 的许可与版权声明，见 [LICENSE](LICENSE)。
