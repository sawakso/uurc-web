// 站点所有者的入口鉴权：口令 + HMAC 签名 Cookie。
//
// 为什么不再依赖 Cloudflare Access：
// Access 是按主机名/Worker 整体放行的，分享链接必须再拆出按路径的 Bypass 应用；
// 而「Worker 目标 + 路径放行」在控制台上做不出来（会报
// use_clientless_isolation_app_launcher_url can only be enabled for apps with private
// destinations 之类的错误），导致访客永远被邮箱验证码挡住。
// 这里把门挪进 Worker 自己：口令在服务端比对，登录态用签名 Cookie 承载，
// 分享路径本来就不需要主人身份，因此再也不会被入口鉴权误伤。

const encoder = new TextEncoder();

const COOKIE_NAME = "uurc_owner";
const TOKEN_VERSION = "v1";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES_PER_IP = 8;
const MAX_FAILURES_TOTAL = 40;
export const MIN_PASSPHRASE_LENGTH = 8;

export interface OwnerAuthEnv {
  /** 主人登录口令。用 `wrangler secret put OWNER_PASSPHRASE` 或控制台的机密变量设置。 */
  OWNER_PASSPHRASE?: string;
  /** 签名密钥；不设时退回用口令本身签名，一套口令也能跑起来。 */
  SESSION_SECRET?: string;
}

interface FailureBucket {
  count: number;
  resetAt: number;
}

const ipFailures = new Map<string, FailureBucket>();
let globalFailures: FailureBucket | null = null;

export function ownerAuthConfigured(env: OwnerAuthEnv): boolean {
  return (env.OWNER_PASSPHRASE ?? "").trim().length >= MIN_PASSPHRASE_LENGTH;
}

export function ownerAuthMisconfiguredReason(env: OwnerAuthEnv): string {
  const value = (env.OWNER_PASSPHRASE ?? "").trim();
  if (value.length === 0) {
    return "服务端还没设置登录口令。请在 Cloudflare 控制台的 Worker 设置里添加机密变量 OWNER_PASSPHRASE（至少 8 位），再重新部署。";
  }
  return `服务端配置的登录口令太短（至少 ${MIN_PASSPHRASE_LENGTH} 位）。`;
}

/** 某 IP 最近是否还能继续试口令。进程内计数，换 isolate 会重置——够挡住脚本爆破，不做账号体系。 */
export function assertLoginAllowed(
  ip: string,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const perIp = readBucket(ipFailures.get(ip), now);
  if (perIp && perIp.count >= MAX_FAILURES_PER_IP) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((perIp.resetAt - now) / 1000)) };
  }
  const global = readBucket(globalFailures ?? undefined, now);
  if (global && global.count >= MAX_FAILURES_TOTAL) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((global.resetAt - now) / 1000)) };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  ipFailures.set(ip, bump(ipFailures.get(ip), now));
  globalFailures = bump(globalFailures ?? undefined, now);
  // 顺手清理过期条目，避免 Map 无上限增长。
  if (ipFailures.size > 512) {
    for (const [key, bucket] of ipFailures) {
      if (bucket.resetAt <= now) ipFailures.delete(key);
    }
  }
}

export function clearLoginFailures(ip: string): void {
  ipFailures.delete(ip);
}

export async function verifyOwnerPassphrase(env: OwnerAuthEnv, candidate: string): Promise<boolean> {
  const expected = (env.OWNER_PASSPHRASE ?? "").trim();
  if (expected.length === 0) return false;
  const [actualDigest, expectedDigest] = await Promise.all([sha256Hex(candidate.trim()), sha256Hex(expected)]);
  return timingSafeEqualHex(actualDigest, expectedDigest);
}

export async function hasValidOwnerSession(
  request: Request,
  env: OwnerAuthEnv,
  now = Date.now(),
): Promise<boolean> {
  const raw = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = await hmacHex(await signingSecret(env), `${TOKEN_VERSION}.${parts[1]}.${parts[2]}`);
  return timingSafeEqualHex(expected, parts[3]);
}

export async function issueOwnerSessionCookie(
  request: Request,
  env: OwnerAuthEnv,
  now = Date.now(),
): Promise<string> {
  const expiresAt = now + SESSION_TTL_MS;
  const nonce = randomHex(12);
  const signature = await hmacHex(await signingSecret(env), `${TOKEN_VERSION}.${expiresAt}.${nonce}`);
  const value = `${TOKEN_VERSION}.${expiresAt}.${nonce}.${signature}`;
  return serializeCookie(request, value, Math.floor(SESSION_TTL_MS / 1000));
}

export function clearOwnerSessionCookie(request: Request): string {
  return serializeCookie(request, "", 0);
}

export function readClientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function serializeCookie(request: Request, value: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  // SameSite=Lax：分享页与主控页同站，跨站提交带不上这条 Cookie；
  // HttpOnly：脚本读不到，避免 XSS 直接偷走登录态。
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

async function signingSecret(env: OwnerAuthEnv): Promise<string> {
  const explicit = (env.SESSION_SECRET ?? "").trim();
  if (explicit.length > 0) return explicit;
  return (env.OWNER_PASSPHRASE ?? "").trim();
}

function readBucket(bucket: FailureBucket | undefined, now: number): FailureBucket | null {
  if (!bucket) return null;
  if (bucket.resetAt <= now) return null;
  return bucket;
}

function bump(bucket: FailureBucket | undefined, now: number): FailureBucket {
  const current = readBucket(bucket, now);
  if (!current) return { count: 1, resetAt: now + FAILURE_WINDOW_MS };
  return { count: current.count + 1, resetAt: current.resetAt };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(signature);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(digest);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
