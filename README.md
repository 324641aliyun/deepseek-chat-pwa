# DeepSeek 对话（手机版）

基于 DeepSeek 官方开源聊天客户端 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)（MIT）修改而来：保留官方界面与联网搜索、深度思考、附件、语音、Markdown/KaTeX/Mermaid、历史导入导出等能力，另外把 DSH「基础对话」预设里那套工具调用合了进来，并做成两种装法：**Android APK**（推荐，工具最全）和 **PWA**（免安装，浏览器限制稍多）。

- 源码：<https://github.com/324641aliyun/deepseek-chat-pwa>
- 上游项目：<https://github.com/deepseek-ai/chat-demo>
- 网页版（PWA）：<https://324641aliyun.github.io/deepseek-chat-pwa/>
- 本版基于上游 0.1.3（2026-11-23T16:05+09:00 (Asia/Tokyo) 同步）


## 1.1.0 修复（2026-11-23T18:20+09:00 (Asia/Tokyo)）

- **全面屏留白**：Android 15+ / HyperOS 强制 edge-to-edge，状态栏与手势条会盖住页面。现在由外壳（Capacitor SystemBars）注入 `--safe-area-inset-*`，页面在 `.frame`、弹窗遮罩、搜索面板与 toast 上统一让开；`viewport-fit=cover` 保持不变。`tools/check-safe-area.mjs` 会注入 48/34 的留白并断言内边距真的生效。
- **B 站逐帧**：之前不可用的根因是 `CapacitorHttp` 插件没打开，WebView 的跨域请求被 CORS 拦掉。现在 `capacitor.config.ts` 显式 `plugins.CapacitorHttp.enabled = true`；同时加入风控（412/-412/-352）时的 buvid 重试、`OffscreenCanvas` 不可用时的 canvas 回退、多分 P 与短链解析、以及时间点换算（接口 `index` 实测是秒）。
- **网页抓取**：`web_fetch` 改走原生网络，不再需要电脑上的本地服务（PWA 里仍可配本地服务）。
- **语音输入标记**：见上表。
- **release 构建**：R8 + 资源裁剪 + 自签名 release 证书，包体 6.1 MB → 2.66 MB，非 debuggable；桌面图标换成品牌图标（自适应图标 + 各密度兜底），启动窗口白底避免闪黑；`windowSoftInputMode=adjustResize` 让输入框不被键盘挡住。

### Android 构建注意事项（本机验证过的坑）

- `sdkmanager` 拉不到仓库清单，SDK 组件需按官方 XML 直接下载解压；缺 `package.xml` 时 `avdmanager` 会认为包未安装。
- Gradle 需要 **build-tools 35.0.0** 才能跑 R8；`lintVitalRelease` 对 Capacitor 桥接 Activity 误报 `Instantiatable`，已在 `build.gradle` 关闭发布期 lint。
- 在本机以 SYSTEM 身份并行跑 Gradle 时，`mergeJavaResource` 会偶发 `AccessDeniedException`（临时目录创建竞态）；加 `-Dorg.gradle.workers.max=1` 后稳定。
## 装到手机（Android）

### 方式一：APK（推荐）

到 [Releases](https://github.com/324641aliyun/deepseek-chat-pwa/releases) 下载 `deepseek-chat-1.1.0.apk`（约 2.7 MB），在手机上打开安装（允许「安装未知来源应用」）。打开后先在设置里填 API Key。

APK 里内置了网页资源和原生网络，所以：

- `web_fetch` 直接可用，**不需要电脑**；
- `read_bilibili_video` 可用，B 站视频逐帧阅读；
- 不需要网络托管也能打开界面。

### 方式二：PWA

1. 用手机 Chrome 打开 <https://324641aliyun.github.io/deepseek-chat-pwa/>
2. 右上角菜单 → **安装应用 / 添加到主屏幕**
3. 设置里填 API Key（`sk-` 开头，来自 <https://platform.deepseek.com>）

PWA 里 B 站逐帧用不了（浏览器跨域），`web_fetch` 需要电脑上的本地工具服务。

## 和官方 demo 的差别

**人格与工具**（合并自 DSH「基础对话」预设，但提示词按官方 demo 的写法重写，只用一句话说明身份，再加一段工具使用说明）：

| 能力 | 说明 | APK | PWA |
| --- | --- | --- | --- |
| 多轮工具调用 | 模型可以连续多轮思考、调用工具、看结果再决定下一步；单轮最多 8 轮，不会只调一次 | ✅ | ✅ |
| `calculate` | 受限算术求值（`+ - * / % ^`、括号、`pi`/`e`、12 个数学函数），不做代码执行 | ✅ | ✅ |
| `search_conversation` | 在本会话全部历史里检索（关键词 / 正则 / 指定轮次 / 最近若干轮），**被压缩掉的旧轮次也能查到** | ✅ | ✅ |
| `read_conversation` | 按轮次或单条消息读取原文 | ✅ | ✅ |
| `read_uploaded_file` | 列出/读取用户在本会话上传的文本附件，上限 2 MiB，只认本会话的上传 | ✅ | ✅ |
| `web_fetch` | 抓取网页正文；APK 用原生网络直接抓，PWA 需要电脑上的本地工具服务 | ✅ | 需本地服务 |
| `read_bilibili_video` | 读 B 站视频画面：BV 号、链接或 b23.tv 短链，每批最多 24 帧，画面会作为图片交给模型 | ✅ | ❌ |
| 语音输入标注 | 用语音输入的消息会带上「语音输入」标记，请求里也会提示模型这是转写文本、可能有同音字或断句错误，让它按上下文纠正 | ✅ | ✅ |

**B 站帧是怎么来的**：不解码视频，直接用播放器的「视频快照」雪碧图（`videoshot` 接口，10×10 网格、每格 480×270，按时间点采样），裁成帧后上传 Files API，作为图片块放进工具结果。代价是分辨率固定、采样间隔由 B 站决定（通常几秒一张）、只覆盖画面不含音轨与字幕。

**上下文**：

- 接近窗口时自动把较早的轮次摘要成检查点，**最近 20 轮逐字保留**；历史本身超窗时分块摘要再合并。
- 输入 `/compact` 立即压缩一次，并给出一条提示。
- 原始消息一条都不删，压缩只影响「发给模型的上下文从哪里开始」，所以检索和界面展示仍是全文。

**设置里新增三项**：工具调用开关（开启后固定使用深度思考——接口要求客户端工具只能在思考模式下用）、自动压缩开关、本地工具服务地址（APK 里自动隐藏）。

## 可选：电脑上的本地工具服务（PWA 用）

浏览器里读不了别的站点的正文，`web_fetch` 需要电脑上这个零依赖小服务：

```sh
node helper/server.mjs            # 默认 8787 端口
```

然后在设置里把「本地工具服务」填成 `http://<电脑局域网 IP>:8787`，两台设备连同一个 Wi-Fi。Windows 首次运行会弹防火墙授权，允许专用网络即可。服务只做两件事：`GET /health` 健康检查、`GET /fetch?url=…` 抓正文；不保存任何内容。

电脑关机时这个工具会自动从工具列表里消失，其余功能照常。

## 打 APK

需要 JDK 21 + Android SDK（platform 36、build-tools 36、platform-tools）。本机已验证的流程：

```sh
pnpm build\nnpx cap sync android\ncd android
# local.properties 里写 sdk.dir=<SDK 路径>，或设置 ANDROID_HOME
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/release/app-release.apk
```

`android/` 是 Capacitor 生成的原生壳；`capacitor.config.ts` 里 `webDir: dist`，所以每次都先 `pnpm build` 再 `cap sync`。

## 未移植的部分

- DSH 预设里的 `web_search`：官方 demo 自带服务端联网搜索（含边想边搜与来源引用），能力等价，不重复实现。
- B 站帧不含音轨、字幕与评论，采样时间点由 B 站的快照接口决定，不能像解码那样任意取某一秒。

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


