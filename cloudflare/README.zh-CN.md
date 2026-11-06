# Cloudflare 部署

[English](README.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iola1999/uurc-web)

本部署方式使用 Cloudflare Worker + Durable Object，不依赖 Cloudflare Containers。

## Cloudflare 运行内容

- 来自 `frontend/dist` 的静态前端
- `/api/proxy/uu` UU API 转发
- `/api/health`
- 基于 Durable Object 的 `/api/remote/signal/*` 状态、事件、诊断和错误回报接口

Worker 版 live signal gateway 已在 Durable Object 内实现，通过 Worker `fetch(..., Upgrade: websocket)` 建立上游 Engine.IO/Socket.IO WebSocket。

## 要求

- Cloudflare Workers 账号，并已启用 Durable Objects。
- 部署/构建 token 需要 `Workers Scripts Edit` 权限。

## 部署

```bash
npx wrangler login
npm run deploy:cloudflare
```

本地 Cloudflare runtime 预览：

```bash
npm run dev:cloudflare
```

## 控制台怎么登录：二选一

Worker 只认两种主人身份，配了前者就不再要口令：

**A. Cloudflare Access（推荐）**

1. Zero Trust 里对 `uurc.sawakso.com` 保留一条 Allow 策略（你的邮箱）。
2. 建两条 Bypass 应用放行访客路径（脚本走 API，避开控制台表单的已知报错）：

   ```bash
   CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx DOMAIN=uurc.sawakso.com \
     node cloudflare/setup-access-bypass.mjs
   ```

3. 把应用页上的 AUD 标签填进 `wrangler.jsonc` 的 `ACCESS_AUD`，然后推送部署。

Worker 会验 `Cf-Access-Jwt-Assertion` 的 RS256 签名（`ACCESS_TEAM_DOMAIN` 已在 `vars` 里），
所以不需要 `OWNER_PASSPHRASE`。细节见 `cloudflare/SHARE.zh-CN.md`。

**B. 自己的口令（没有 Access 时兜底）**

`ACCESS_AUD` 留空时启用：`/api/remote/*` 与 `/api/proxy/uu` 比对口令并签发 HttpOnly 签名 Cookie，
有效期 14 天。此时**必须**设：

```bash
npx wrangler secret put OWNER_PASSPHRASE
```

要求至少 8 位；不设则这些接口一律 503（fail-closed，不会裸奔）。
可选再设 `SESSION_SECRET` 做签名密钥（不设时用口令本身签名）。

分享链接（`/share/<id>`、`/api/share/*`）两种模式下都不过这道门，
访客只面对你生成链接时设的观看口令。

## 说明

- 配置位于 `wrangler.jsonc`。
- 部署流程会执行 `npm run build:cloudflare`，构建 `shared` 和 `frontend`。
