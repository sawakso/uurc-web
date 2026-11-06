import { RemoteSignalSession } from "./signalSession";
import { ShareSession, hashPassword } from "./shareSession";
import type { RemoteSignalSession as RemoteSignalSessionClass } from "./signalSession";
import { createRuntimeProfile } from "@uurc/shared/runtimeProfile";
import {
  assertAllowedUuApiMethod,
  assertAllowedUuApiPath,
  parseMaybeJsonBody,
  pickForwardableUuResponseHeaders,
  sanitizeUuProxyHeaders,
} from "@uurc/shared/uuProxy";
import {
  RemoteSignalValidationError,
  parseSignalControlRequest,
  parseSignalGatewayStartRequest,
  parseSignalSoacRequest,
} from "@uurc/shared/signalGatewayProtocol";
import {
  assertLoginAllowed,
  clearLoginFailures,
  clearOwnerSessionCookie,
  hasValidOwnerSession,
  issueOwnerSessionCookie,
  ownerAuthConfigured,
  ownerAuthMisconfiguredReason,
  readClientIp,
  recordLoginFailure,
  verifyOwnerPassphrase,
} from "./ownerAuth";

const API_BASE = "https://api.nrd.nie.163.com";
const UU_PROXY_TIMEOUT_MS = 30_000;
const MAX_JSON_BODY_BYTES = 1_048_576;

type JsonRecord = Record<string, unknown>;

interface Env {
  ASSETS: Fetcher;
  REMOTE_SIGNAL_SESSION: DurableObjectNamespace<RemoteSignalSessionClass>;
  SHARE_SESSION: DurableObjectNamespace;
  // 主人登录口令与签名密钥，都由 Worker 自己校验（不再依赖 Cloudflare Access）。
  // 未配置时 /api/remote/* 与 /api/proxy/uu 一律 403，属于 fail-closed。
  OWNER_PASSPHRASE?: string;
  SESSION_SECRET?: string;
}

class BodyTooLargeError extends Error {}

export { RemoteSignalSession, ShareSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, runtime: "cloudflare-worker" });
    }
    if (url.pathname === "/api/runtime") {
      return json(createRuntimeProfile("cloudflare-worker"));
    }
    // 入口鉴权：这三条必须公开，否则登录页自己也进不去。
    // 分享路径（/share/*、/api/share/*）本来就不经过这里，访客不会被主人的登录态牵连。
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      return handleAuthSession(request, env);
    }
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return handleAuthLogin(request, env);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return handleAuthLogout(request);
    }
    if (url.pathname === "/api/proxy/uu" && request.method === "POST") {
      const guard = await requireOwner(request, env);
      if (guard) return guard;
      return handleUuProxy(request);
    }
    // 创建分享只对主人开放：它需要一个主人身份，所以挡在登录态之后。
    // 必须排在 "/api/remote/" 前缀判断之前——否则会被远端 API 路由吞掉，返回 not found。
    if (url.pathname === "/api/remote/share/create") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
      const guard = await requireOwner(request, env);
      if (guard) return guard;
      return handleShareCreate(request, env);
    }
    if (url.pathname.startsWith("/api/remote/")) {
      return handleRemoteApi(request, env);
    }
    // 分享链接：访客没有主人登录态，所以这条路径自身承担鉴权（口令 / 主控令牌）。
    if (url.pathname.startsWith("/api/share/")) {
      return handleShareApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleUuProxy(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const method = typeof body.method === "string" ? body.method.trim().toUpperCase() : "";
    const path = typeof body.path === "string" ? body.path : "";
    if (!method || !path) {
      return json({ error: "method and path are required" }, { status: 400 });
    }
    // 双重校验：路径走精确 allowlist，方法只允许 GET/POST。
    assertAllowedUuApiPath(path);
    assertAllowedUuApiMethod(method);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UU_PROXY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: sanitizeUuProxyHeaders(body.headers),
        body: body.body === undefined ? undefined : JSON.stringify(body.body),
        // 不跟随重定向：避免上游 30x 把请求带到非预期主机。
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const responseText = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    return json({
      status: response.status,
      statusText: response.statusText,
      // 只回显白名单响应头，避免把 Set-Cookie 写到本站域名下。
      headers: pickForwardableUuResponseHeaders(response.headers),
      body: parseMaybeJsonBody(responseText, contentType),
    });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: "request body too large" }, { status: 413 });
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

interface ShareCreateBody {
  password?: unknown;
  controlPassword?: unknown;
}

const SHARE_ID_PATTERN = /^[0-9a-f]{20}$/;

async function handleShareCreate(request: Request, env: Env): Promise<Response> {
  let body: ShareCreateBody;
  try {
    body = (await readJsonBody(request)) as ShareCreateBody;
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json({ error: "request body too large" }, { status: 413 });
    throw error;
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 4 || password.length > 64) {
    return json({ error: "观看口令长度需在 4-64 个字符之间" }, { status: 400 });
  }
  // 控制口令：观看不需要它，动手才需要。留空表示"谁拿到观看口令谁就能操作"。
  const controlPassword = typeof body.controlPassword === "string" ? body.controlPassword.trim() : "";
  if (controlPassword && (controlPassword.length < 4 || controlPassword.length > 64)) {
    return json({ error: "控制口令长度需在 4-64 个字符之间" }, { status: 400 });
  }

  // 分享 ID 随机且不可猜：它只是定位 DO，真正的门是口令。
  const shareId = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // 主控令牌：只回给创建者的浏览器，用来在公开的 WebSocket 上证明"我是主控"。
  const hostToken = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const session = env.SHARE_SESSION.getByName(shareId);
  const response = await session.fetch(
    new Request("https://share.internal/configure", {
      method: "POST",
      headers: { "content-type": "application/json", "x-uurc-share-action": "configure" },
      body: JSON.stringify({
        passwordHash: await hashPassword(password),
        hostTokenHash: await hashPassword(hostToken),
        controlPasswordHash: controlPassword ? await hashPassword(controlPassword) : "",
      }),
    }),
  );
  if (!response.ok) return json({ error: "创建分享失败" }, { status: 500 });
  return json({ shareId, hostToken });
}

async function handleShareApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rest = url.pathname.slice("/api/share/".length);
  const [shareId, sub] = rest.split("/");
  if (!shareId || !SHARE_ID_PATTERN.test(shareId)) {
    return json({ error: "分享链接无效" }, { status: 404 });
  }
  const session = env.SHARE_SESSION.getByName(shareId);

  if (!sub && request.method === "GET") {
    const info = await session.fetch(
      new Request("https://share.internal/info", { headers: { "x-uurc-share-action": "info" } }),
    );
    return new Response(info.body, { status: info.status, headers: info.headers });
  }

  if (sub === "ws") {
    // 主控 / 访客一律靠第一条 auth 消息自证（主控令牌或口令），
    // 这样即使这条路径完全公开，也不会有人靠伪造请求头抢到主控身份。
    return session.fetch(new Request(request.url, { headers: request.headers }));
  }

  return json({ error: "Not found" }, { status: 404 });
}

async function handleRemoteApi(request: Request, env: Env): Promise<Response> {
  const guard = await requireOwner(request, env);
  if (guard) return guard;

  const url = new URL(request.url);
  // 单主人模式：整个部署只服务一个账号，所以 DO 名固定，多浏览器共用同一条远控会话。
  const session = env.REMOTE_SIGNAL_SESSION.getByName(OWNER_SESSION_NAME);

  try {
    if (url.pathname === "/api/remote/bootstrap") {
      return json({ error: "Cloudflare Worker stores room bootstrap in the browser session. Use the frontend flow to join a room first." }, { status: 404 });
    }
    if (url.pathname === "/api/remote/signal/start" && request.method === "POST") {
      return json(await session.start(parseSignalGatewayStartRequest(await readJsonBody(request))));
    }
    if (url.pathname === "/api/remote/signal/status" && request.method === "GET") {
      return json(await session.getStatus());
    }
    if (url.pathname === "/api/remote/signal/events" && request.method === "GET") {
      return json(await session.getEvents());
    }
    if (url.pathname === "/api/remote/signal/diagnostics" && request.method === "GET") {
      return json(await session.getDiagnostics());
    }
    if (url.pathname === "/api/remote/signal" && request.method === "DELETE") {
      return json(await session.stop());
    }
    if (url.pathname === "/api/remote/signal/control" && request.method === "POST") {
      const result = await session.sendControl(parseSignalControlRequest(await readJsonBody(request)));
      if (!result) return json({ error: "Start the signal gateway before sending control" }, { status: 409 });
      return json(result);
    }
    if (url.pathname === "/api/remote/signal/soac" && request.method === "POST") {
      const result = await session.sendSoac(parseSignalSoacRequest(await readJsonBody(request)));
      if (!result) return json({ error: "Start the signal gateway before sending SOAC" }, { status: 409 });
      return json(result);
    }
    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof RemoteSignalValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    if (error instanceof BodyTooLargeError) {
      return json({ error: "request body too large" }, { status: 413 });
    }
    // 只记录错误类型：异常消息里可能带上游回包内容，不进日志。
    console.log(`[uurc-worker] remote api error name=${error instanceof Error ? error.name : typeof error}`);
    return json({ error: "internal error" }, { status: 500 });
  }
}

// 单主人部署，信号会话固定落在这个 DO 上。
const OWNER_SESSION_NAME = "owner";

// 只拒绝、不猜：服务端没配口令时明确 503，配了口令但 Cookie 无效时 401。
// 前端据此区分「去登录」和「去改配置」，不会卡在无解的登录页上。
async function requireOwner(request: Request, env: Env): Promise<Response | null> {
  if (!ownerAuthConfigured(env)) {
    return json({ error: ownerAuthMisconfiguredReason(env), code: "owner_auth_unconfigured" }, { status: 503 });
  }
  if (await hasValidOwnerSession(request, env)) return null;
  return json({ error: "需要先登录控制台", code: "owner_auth_required" }, { status: 401 });
}

async function handleAuthSession(request: Request, env: Env): Promise<Response> {
  const configured = ownerAuthConfigured(env);
  return json({
    configured,
    authenticated: configured && (await hasValidOwnerSession(request, env)),
    message: configured ? "" : ownerAuthMisconfiguredReason(env),
  });
}

async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  if (!ownerAuthConfigured(env)) {
    return json({ error: ownerAuthMisconfiguredReason(env), code: "owner_auth_unconfigured" }, { status: 503 });
  }
  const ip = readClientIp(request);
  const limit = assertLoginAllowed(ip);
  if (!limit.allowed) {
    return json(
      { error: `尝试次数过多，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再试` },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    );
  }

  let body: JsonRecord;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json({ error: "request body too large" }, { status: 413 });
    throw error;
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length === 0 || password.length > 256) {
    return json({ error: "请输入登录口令" }, { status: 400 });
  }
  if (!(await verifyOwnerPassphrase(env, password))) {
    recordLoginFailure(ip);
    return json({ error: "口令不正确" }, { status: 401 });
  }

  clearLoginFailures(ip);
  return json({ ok: true }, { headers: { "set-cookie": await issueOwnerSessionCookie(request, env) } });
}

async function handleAuthLogout(request: Request): Promise<Response> {
  // 无状态 Cookie：清了客户端就够了，服务端不留会话表。
  return json({ ok: true }, { headers: { "set-cookie": clearOwnerSessionCookie(request) } });
}

async function readJsonBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  return isRecord(parsed) ? parsed : {};
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  // 响应内含会话状态与信令诊断信息，禁止任何中间层缓存。
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
