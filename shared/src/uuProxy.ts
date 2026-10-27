// UU API 转发的白名单与清洗规则。
// 注意：本文件同时被 Node 后端与 Cloudflare Worker 使用，收紧规则对两端同时生效。

// 前端实际使用的全部 UU 接口（来源：shared/src/loginFlow.ts、shared/src/constants.ts、
// frontend/src/uu/uuClient.ts）。新增业务接口时必须同步登记，否则会被拒绝转发。
const ALLOWED_EXACT_PATHS = new Set([
  "/api/v1/security/mobile/code",
  "/api/v1/login/by_mobile",
  "/api/v1/device/android/init",
  "/api/v1/device/groups/of/my",
  "/api/v1/room/app_flag",
  "/api/v2/room/join/share/by_code",
  "/api/v2/room/join/share/by_confirmation",
  "/api/v2/room/share/control_mode",
  "/api/v2/room/share/cancel_remote_assist",
]);

// 路径中带设备 ID 的接口，ID 只允许 URL-safe 字符，禁止斜杠与编码穿越。
const ALLOWED_PATH_PATTERNS = [
  /^\/api\/v1\/room\/join\/by_device\/[A-Za-z0-9._-]{1,64}$/,
  /^\/api\/v1\/room\/clear\/by_device\/[A-Za-z0-9._-]{1,64}$/,
];

// UU 业务接口只需要读与写；其余方法（PUT/DELETE/PATCH/TRACE 等）一律不转发。
const ALLOWED_METHODS = new Set(["GET", "POST"]);

const BLOCKED_PROXY_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "proxy-connection",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "keep-alive",
]);

// 这些前缀的请求头属于边缘/代理环境，不应转发到上游（尤其不能把 Access JWT 送出去）。
const BLOCKED_PROXY_HEADER_PREFIXES = ["cf-", "cf_", "x-forwarded-", "x-real-ip"];

// 上游响应头只回显白名单，避免把 Set-Cookie 之类写到本站域名下。
const FORWARDABLE_RESPONSE_HEADERS = new Set(["content-type", "date", "cache-control"]);

export const UU_PROXY_MAX_PATH_LENGTH = 512;

export function assertAllowedUuApiPath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > UU_PROXY_MAX_PATH_LENGTH) {
    throw new Error("Unsafe UU API path");
  }
  if (/[\s\\"'<>]/.test(path)) {
    throw new Error("Unsafe UU API path");
  }
  if (path.includes("..")) {
    throw new Error(`Unsafe UU API path: ${path}`);
  }

  const pathOnly = path.split("?")[0] ?? path;
  if (!pathOnly.startsWith("/") || pathOnly.startsWith("//")) {
    throw new Error(`Unsupported UU API path: ${path}`);
  }
  if (ALLOWED_EXACT_PATHS.has(pathOnly)) return;
  if (ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(pathOnly))) return;

  throw new Error(`Unsupported UU API path: ${path}`);
}

export function assertAllowedUuApiMethod(method: string): void {
  if (!ALLOWED_METHODS.has(method.toUpperCase())) {
    throw new Error(`Unsupported UU API method: ${method}`);
  }
}

export function sanitizeUuProxyHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && isForwardableUuProxyHeader(key)) {
      headers[key] = raw;
    }
  }
  return headers;
}

export function isForwardableUuProxyHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (BLOCKED_PROXY_HEADERS.has(lower)) return false;
  return !BLOCKED_PROXY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function pickForwardableUuResponseHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (FORWARDABLE_RESPONSE_HEADERS.has(key.toLowerCase())) {
      picked[key.toLowerCase()] = value;
    }
  }
  return picked;
}

export function parseMaybeJsonBody(text: string, contentType: string): unknown {
  if (!text) return null;
  if (!contentType.includes("application/json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
