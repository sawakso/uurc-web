import { RemoteSignalSession } from "./signalSession";
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

const API_BASE = "https://api.nrd.nie.163.com";
const UU_PROXY_TIMEOUT_MS = 30_000;
const MAX_JSON_BODY_BYTES = 1_048_576;

type JsonRecord = Record<string, unknown>;

interface Env {
  ASSETS: Fetcher;
  REMOTE_SIGNAL_SESSION: DurableObjectNamespace<RemoteSignalSessionClass>;
  // 默认 fail-closed：拿不到 Cloudflare Access 身份就拒绝，避免误删 Access 策略后整站裸奔。
  // 本地 wrangler dev 需要 .dev.vars 里设置 REQUIRE_ACCESS=false。
  REQUIRE_ACCESS?: string;
}

class BodyTooLargeError extends Error {}

export { RemoteSignalSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, runtime: "cloudflare-worker" });
    }
    if (url.pathname === "/api/runtime") {
      return json(createRuntimeProfile("cloudflare-worker"));
    }
    if (url.pathname === "/api/proxy/uu" && request.method === "POST") {
      const guard = assertAccessIdentity(request, env);
      if (guard) return guard;
      return handleUuProxy(request);
    }
    if (url.pathname.startsWith("/api/remote/")) {
      return handleRemoteApi(request, env);
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

async function handleRemoteApi(request: Request, env: Env): Promise<Response> {
  const access = await resolveAccessIdentity(request, env);
  if (access instanceof Response) return access;

  const url = new URL(request.url);
  // 每个 Access 用户一个 DO：不同账号（例如你给家人开的账号）不会互相串话或互顶会话。
  // 同一账号的多个浏览器仍共用一条远控会话，保持原有使用习惯。
  const session = env.REMOTE_SIGNAL_SESSION.getByName(access.sessionName);

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

interface AccessIdentity {
  sessionName: string;
}

// 注意：这里是 fail-closed 的卫生检查，不是密码学校验。
// 真正的身份边界是 Cloudflare Access（加上 workers_dev=false 关掉绕行入口）；
// 若要防"能直达 Worker 的人伪造 cf-* 头"，需要再校验 Cf-Access-Jwt-Assertion 的签名。
function assertAccessIdentity(request: Request, env: Env): Response | null {
  if ((env.REQUIRE_ACCESS ?? "true") === "false") return null;
  const email = request.headers.get("cf-access-authenticated-user-email")?.trim() ?? "";
  if (email) return null;
  return json({ error: "Cloudflare Access identity is required" }, { status: 403 });
}

async function resolveAccessIdentity(request: Request, env: Env): Promise<AccessIdentity | Response> {
  const guard = assertAccessIdentity(request, env);
  if (guard) return guard;

  const email = request.headers.get("cf-access-authenticated-user-email")?.trim().toLowerCase() ?? "";
  if (!email) return { sessionName: "unauthenticated" };

  // 用邮箱哈希做 DO 名称：不在 DO ID 里留下明文邮箱，同时保持同一用户稳定映射。
  const hex = await sha256Hex(email);
  return { sessionName: `user-${hex.slice(0, 32)}` };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
