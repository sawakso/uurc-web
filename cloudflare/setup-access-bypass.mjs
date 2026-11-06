#!/usr/bin/env node
// 用 API 建「分享路径绕过 Access」的三条应用，绕开控制台表单的 known bug
// （新建公网主机名应用时保存会报 use_clientless_isolation_app_launcher_url ...）。
//
// 用法（Git Bash / macOS / Linux 都一样）：
//   CF_API_TOKEN=xxx node cloudflare/setup-access-bypass.mjs
//   也可把令牌写进项目根目录 .cf-token（已 gitignore），然后直接 node cloudflare/setup-access-bypass.mjs
//   CF_ACCOUNT_ID 可省略，只有一个账号时自动取。
//
// API Token 需要权限：Account → Access: Apps and Policies → Edit。
// 脚本可重复执行：已存在的目标会被跳过，不会重复建。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 令牌文件固定读项目根目录，不受当前工作目录影响。
const tokenFile = join(fileURLToPath(new URL("..", import.meta.url)), ".cf-token");

let token = process.env.CF_API_TOKEN?.trim();
let accountId = process.env.CF_ACCOUNT_ID?.trim();
const domain = process.env.DOMAIN?.trim() ?? "uurc.sawakso.com";

// 顺手支持从文件读令牌，省得每次翻历史命令（文件已在 .gitignore 里）。
if (!token && existsSync(tokenFile)) {
  token = readFileSync(tokenFile, "utf8").trim();
}

if (!token) {
  console.error("缺少 CF_API_TOKEN。两种给法都行：");
  console.error("  A. 环境变量：CF_API_TOKEN=xxx node cloudflare/setup-access-bypass.mjs");
  console.error("  B. 把令牌粘进项目根目录的 .cf-token 文件，然后直接 node cloudflare/setup-access-bypass.mjs");
  process.exit(1);
}

const BASE = "https://api.cloudflare.com/client/v4";

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    const detail = body?.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") ?? response.statusText;
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${detail}`);
  }
  return body?.result;
}

const targets = [
  { name: "uurc-share-page", path: "share" },
  { name: "uurc-share-api", path: "api/share" },
  // 分享页的 HTML 过了 Access，但它引用的 /assets/*.js|css 不在 /share 下面。
  // 少了这条，访客看到的是空白页（脚本被 302 到登录页，拿不到 MIME 正确的 JS）。
  // 前端产物本身就是公开代码，放行它不泄露任何数据，接口仍然各自有门。
  { name: "uurc-static-assets", path: "assets" },
];

// 先验证令牌本身，避免后面报一堆看不懂的 403。
let tokenStatus;
try {
  tokenStatus = await api("/user/tokens/verify");
} catch (error) {
  console.error(`令牌校验失败：${error.message}`);
  console.error("常见原因：复制时多了空格、令牌已过期、或建令牌时没选 Account → Access: Apps and Policies → Edit。");
  process.exit(1);
}
console.log(`令牌可用，状态：${tokenStatus?.status ?? "active"}`);

// 省略 CF_ACCOUNT_ID 时自动探测：只有一个账号就直接用。
if (!accountId) {
  let accounts = [];
  try {
    accounts = (await api("/accounts")) ?? [];
  } catch (error) {
    console.error(`自动识别账号失败：${error.message}`);
    console.error(
      "请改用显式指定：CF_ACCOUNT_ID=xxx node cloudflare/setup-access-bypass.mjs（账号 ID 在控制台右下角或 URL 里）。",
    );
    process.exit(1);
  }
  if (accounts.length === 1) {
    accountId = accounts[0].id;
    console.log(`自动识别账号：${accounts[0].name}（${accountId}）`);
  } else if (accounts.length === 0) {
    console.error("这个令牌看不到任何账号。建令牌时请把 Account Resources 设为「Include → 你的账号」，不要选 User。");
    process.exit(1);
  } else {
    console.error("令牌能看到多个账号，请显式指定 CF_ACCOUNT_ID。可选：");
    for (const account of accounts) console.error(`  ${account.name}  ${account.id}`);
    process.exit(1);
  }
}

const existing = await api(`/accounts/${accountId}/access/apps`);
const byTarget = new Map();
for (const app of existing ?? []) {
  const uris = [app.domain, ...(app.destinations ?? []).map((destination) => destination.uri)].filter(Boolean);
  for (const uri of uris) byTarget.set(String(uri).replace(/^https?:\/\//, ""), app);
}

for (const target of targets) {
  const uri = `${domain}/${target.path}`;
  const hit = byTarget.get(uri);
  if (hit) {
    console.log(`跳过：${uri} 已存在（${hit.name}，${hit.id}）`);
    continue;
  }
  const created = await api(`/accounts/${accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name: target.name,
      type: "self_hosted",
      domain: uri,
      destinations: [{ type: "public", uri }],
      // 这条应用只负责"别拦"，不进 App Launcher，也不碰浏览器隔离，避免踩到那个已知 bug。
      app_launcher_visible: false,
      auto_redirect_to_identity: false,
      session_duration: "24h",
      policies: [
        {
          name: `bypass-${target.path.replaceAll("/", "-")}`,
          decision: "bypass",
          precedence: 1,
          include: [{ everyone: {} }],
        },
      ],
    }),
  });
  console.log(`已创建：${uri}（${created.name}，${created.id}）`);
}

// 把现有应用连同 AUD 打出来，方便直接填进 wrangler.jsonc 的 ACCESS_AUD。
const after = await api(`/accounts/${accountId}/access/apps`);
console.log("\n当前 Access 应用：");
let consoleApp;
for (const app of after ?? []) {
  const uris = [app.domain, ...(app.destinations ?? []).map((destination) => destination.uri)]
    .filter(Boolean)
    .join(", ");
  const decision = app.policies?.[0]?.decision ?? "-";
  console.log(`  ${app.name}  |  ${uris || "(无目标)"}  |  ${decision}  |  aud=${app.aud ?? "-"}`);
  // 控制台那条：目标是整站（不是 /share 这类子路径），且策略不是 bypass。
  const coversSite = app.domain === domain || (app.destinations ?? []).some((d) => d.uri === domain);
  if (coversSite && decision !== "bypass") consoleApp = app;
}

if (consoleApp) {
  console.log(`\n控制台应用的 aud：${consoleApp.aud}`);
  console.log("把它填到控制台（不用改文件）：");
  console.log("  Workers & Pages → uurc-web → Settings → Variables and Secrets");
  console.log("  → Add → 类型 Secret，名称 ACCESS_AUD，值粘贴上面这串 → 保存即生效。");
} else {
  console.log("\n没找到覆盖整站 uurc.sawakso.com 的 Access 应用。");
  console.log(
    "请先在 Zero Trust → Access → Applications 里给 Worker 建一条 Allow 应用（仅放行你自己的邮箱），再跑一次本脚本。",
  );
}
