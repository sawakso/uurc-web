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

## 控制台怎么登录：三种配法

三种都只动 Cloudflare 后台，不需要改仓库文件；区别是「控制台用什么证明你是主人」。

### 方式 1：后台点三下，口令登录（零脚本，最快可用）

1. Zero Trust → Access → Applications：把覆盖 `uurc.sawakso.com` 的那条应用**停用或删除**。
   只要它还在，访客打开分享链接照样会被要求收验证码。
2. Workers & Pages → `uurc-web` → Settings → Variables and Secrets → **Add**
   → 类型选 **Secret**，名称 `OWNER_PASSPHRASE`，值自定（至少 8 位）→ 保存并部署。
3. 打开 `uurc.sawakso.com`，输入这道口令即可；分享链接给访客的仍是「链接 + 观看口令」。

`ACCESS_AUD` 未设置时 Worker 自动走这条路，属于代码里的兜底分支，不用改任何东西。

### 方式 2：保留 Access 邮箱验证（后台要建两条放行应用）

1. Zero Trust 里对 `uurc.sawakso.com` 保留一条 **Allow** 策略（只放行你自己的邮箱）。
2. 给访客路径建两条 **Bypass** 应用：`uurc.sawakso.com/share` 与 `uurc.sawakso.com/api/share`，
   策略 `Bypass` + `Everyone`，且**不要**勾选 App Launcher。
   Worker 级别应用会覆盖整个 Worker 的所有路径，控制台又没法给它加 Path，
   所以只能靠「主机名应用优先于 Worker 应用」把这两条路径盖掉。
   > 控制台新建公网主机名应用时可能报
   > `use_clientless_isolation_app_launcher_url can only be enabled for apps with private destinations`
   > （表单默认值 bug）。要么先把目标建成私有网络应用、保存后再改成公网主机名；
   > 要么跳过控制台，用下面的脚本建。
3. Workers & Pages → `uurc-web` → Settings → Variables and Secrets → Add →
   **Secret**，名称 `ACCESS_AUD`，值填那条 Allow 应用的「应用程序受众 (AUD) 标签」。
   保存即生效，**不用改 `wrangler.jsonc`、不用重新推送**。

Worker 会验 `Cf-Access-Jwt-Assertion` 的 RS256 签名（团队域已在 `vars` 里），签名对不上就是没通过。

### 方式 3：一条命令把两条应用建好

不想在控制台填那个会报错的表单，就用脚本（可重复执行，已存在的会跳过）：

```bash
CF_API_TOKEN=xxx node cloudflare/setup-access-bypass.mjs
```

令牌在 My Profile → API Tokens → Create Custom Token 建，
权限只需 `Account → Access: Apps and Policies → Edit`；账号 ID 可省略，脚本自动识别。
脚本结尾会直接打印该填进 `ACCESS_AUD` 的值。

### 补充

- 口令模式的兜底：`OWNER_PASSPHRASE` 要求至少 8 位，不设则 `/api/remote/*` 与 `/api/proxy/uu` 一律 503（fail-closed，不会裸奔）。
  可选再设 `SESSION_SECRET` 做签名密钥（不设时用口令本身签名），Cookie 有效期 14 天。
- 分享链接（`/share/<id>`、`/api/share/*`）两种模式下都不过控制台这道门，
  访客只面对你生成链接时设的观看口令；能不能操作由控制口令决定。
- `ACCESS_AUD` 走控制台 Secret 而不是 `wrangler.jsonc` 的 `vars`：
  `vars` 里的值每次部署都会被配置覆盖，Secret 不会，所以填一次就永久生效。

## 说明

- 配置位于 `wrangler.jsonc`。
- 部署流程会执行 `npm run build:cloudflare`，构建 `shared` 和 `frontend`。
