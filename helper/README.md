# 本地工具服务

手机上的聊天页受跨域限制，读不了别的站点正文。这个零依赖的小服务只做一件事：替浏览器把网页抓回来。

```sh
node helper/server.mjs              # 默认 8787
node helper/server.mjs --port 8788  # 换端口
```

- `GET /health` → `{ "ok": true, ... }`
- `GET /fetch?url=<编码后的链接>` → `{ url, title, text, truncated }`

限制：只抓 `http/https`、最多 2 MiB、20 秒超时、正文最多 6 万字、允许任意来源跨域（手机页面在另一个域名上）。服务不写磁盘、不记录请求日志。

在手机 App 的「设置 → 本地工具服务」里填 `http://<电脑局域网 IP>:8787`。电脑关机时这个工具会自动从列表里消失，不影响其它功能。
