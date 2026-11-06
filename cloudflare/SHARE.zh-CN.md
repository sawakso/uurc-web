# 分享链接（访客观看 / 操作）

主控页面上的「分享给他人」会生成**一条链接和两个口令**：

- **观看口令**：只能看画面，动不了被控电脑。
- **控制口令**：输入后才解锁鼠标键盘，才能真正操作。

```
访客浏览器  ──WebRTC(画面/输入)──▶  你的主控浏览器  ──已有控制通道──▶  被控电脑
                    ▲
                    └── 信令转发：Cloudflare Durable Object（只转发，不落盘）
```

## 为什么是「经由主控浏览器」而不是让访客直连

UU 的房间只允许一个控制端，访客拿不到（也不应该拿到）room token。
所以访客的画面由你的浏览器转发，输入由你的浏览器回放进已有的控制通道。
代价是：**主控页面必须保持打开**，关掉即断流；访客画质受你的上传带宽限制。

## 操作权限是怎么卡住的

1. 只拿观看口令的访客，服务端在下发 `ready` 时就把 `controlEnabled` 置为 `false`；
2. 访客要动手，必须再发一条 `control-auth`（控制口令）；
3. **Durable Object 侧兜底**：没有换到权限的访客，`input` 消息直接被丢弃，
   前端就算被改过也动不了被控电脑；
4. 控制口令错误只回一条提示，不踢人（还能继续看），并计入防爆破计数。

控制口令留空时，行为退回旧版：拿到观看口令即可操作。

## 入口鉴权：控制台走 Access，分享路径绕过它

目标分工很明确：**你自己**进控制台要过 Cloudflare Access（邮箱验证码），
**访客**只面对分享口令，全程看不到 `cloudflareaccess.com`。

| 路径 | 谁能进 | 怎么验证 |
|---|---|---|
| `/share/<id>`、`/api/share/<id>`、`/api/share/<id>/ws` | 任何拿到链接的人 | Access **Bypass**（不介入）+ 观看口令 / 控制口令 |
| 设备列表、远控页 | 只有你自己 | Access 登录（Allow 策略） |
| `/api/remote/*`、`/api/proxy/uu`、创建分享 | 只有你自己 | 同一个 Access 会话；Worker 校验 JWT |

为什么必须拆成两条应用：Worker 级别的 Access 策略会覆盖这个 Worker 的**所有**域名和路径，
而控制台里给 Worker 目标加 Path 是做不到的。所以给 `share` 与 `api/share` 各建一条
更具体的**主机名**应用，优先级「主机名应用 > Worker 应用」会把它们盖住。

### 一次性配置（三步）

1. 建 API Token：Cloudflare 控制台 → My Profile → API Tokens → Create Token，
   权限选 **Account → Access: Apps and Policies → Edit**，账号限定为你的账号。

2. 建两条 Bypass 应用（脚本可重复执行，已存在的会跳过）：

   ```bash
   CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx DOMAIN=uurc.sawakso.com \
     node cloudflare/setup-access-bypass.mjs
   ```

   脚本走 API 而不是控制台表单，因为表单保存时会报
   `use_clientless_isolation_app_launcher_url can only be enabled for apps with private destinations`
   （那个开关只服务私有目标）。

3. 把输出里保护 `uurc.sawakso.com` 那条应用的 `aud` 填到 `wrangler.jsonc` 的 `ACCESS_AUD`，
   然后推送部署。

### Worker 端怎么认人

校验的是 `Cf-Access-Jwt-Assertion` 的 RS256 签名（公钥取自
`https://<团队域>/cdn-cgi/access/certs`，缓存 1 小时），再核对 `aud` / `iss` / `exp`。

**不信任 `cf-access-authenticated-user-email` 请求头**：一旦 Access 应用被删、或某条路径没被覆盖，
任何能直达 Worker 的人自己发一个同名请求头就能冒充主人。验签则不存在这个口子——
签名不对就是没通过。

两个变量都在 `wrangler.jsonc` 的 `vars` 里，不是机密：

| 变量 | 值 |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `zechuanwangyou.cloudflareaccess.com` |
| `ACCESS_AUD` | 该应用的「应用程序受众 (AUD) 标签」，一串 64 位十六进制 |

`ACCESS_AUD` 留空等于关闭 Access 模式，退回「口令 + 签名 Cookie」的兜底方式
（那时需要 `npx wrangler secret put OWNER_PASSPHRASE`，至少 8 位）。两套门不会同时生效。

### 出问题先看这一句

| 现象 | 原因 |
|---|---|
| 控制台显示「Cloudflare Access 没有放行」 | `ACCESS_AUD` 与该应用不匹配，或 Access 应用没覆盖当前路径 |
| 访客看到 `cloudflareaccess.com` 验证码页 | 两条 Bypass 应用有一条没生效（路径写错、或只建了一条） |
| 接口 503 且提示没配置 | `ACCESS_AUD` 和 `OWNER_PASSPHRASE` 都没配 |

## 访客黑屏怎么排查

访客页会把实时状态写在画面上，按它显示的那一句对号入座：

| 画面上显示 | 含义 | 怎么办 |
|---|---|---|
| 连线状态：`connecting` / `new` 停留很久 | 信令通了但 P2P 没连上 | 换网络重试；对称 NAT 需要 TURN |
| 连线已建立，但主控端没有送来视频轨 | 主控端没有画面可转发 | 主控先连上被控设备、画面出来后重新生成链接 |
| 已收到视频轨（WxH），但还没有解码出画面 | 轨道在但没数据 | 看「路径」：`relay→relay` 说明走了中继且不通 |
| `1920×1080 · 已解码 N 帧 · 路径 host→host` | 正常在播 | — |

主控端面板也会提示「当前没有画面可转发」，避免在没画面时分享出去。

已知会黑屏的两种情况：

- 主控端**先分享、后连接设备**：分享那一刻没有轨道可发。现在的做法是画面到达时补发协商，
  但最稳的仍是先出画面再分享。
- 主控端**重连/切画面**：旧轨道会停帧，现在会把失效的 sender 移除后重新协商。

## 安全边界

- 口令只以 SHA-256 存在分享对应的 Durable Object 里，明文不落盘、不进日志。
- 每次连接最多 4 位访客；10 分钟内错 20 次口令会临时锁定。
- SDP / ICE / 输入事件只做转发，不持久化。
- 分享 ID 为 20 位随机十六进制，猜不到；真正的门是口令。
- 重启分享（重新生成）会让旧链接、旧口令、旧控制权限立即失效。

## 已知限制

- 只转发当前选中的那一路画面；多路画面需要在主控端切换。
- 两端都在对称型 NAT（部分公司网络/4G）后面时，P2P 直连会失败——
  需要 TURN 中继，目前没有接。
- 访客端的音频暂未启用（视频元素是静音的）。
