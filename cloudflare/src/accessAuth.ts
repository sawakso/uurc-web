// Cloudflare Access 身份校验（可选）。
//
// 目标分工：
//   - 控制台（设备列表、远控页、/api/remote/*、/api/proxy/uu）走 Access 登录，不用再记第二个口令；
//   - 分享链接（/share/*、/api/share/*）在 Access 里配成 Bypass，访客只面对分享口令。
//
// 为什么不是「信任 cf-access-authenticated-user-email 请求头」：
// 那个头只有在 Access 真的介入了才有意义。一旦哪天 Access 应用被删或路径没覆盖，
// 任何能直达 Worker 的人自己发一个同名请求头就冒充主人。这里改为校验
// Cf-Access-Jwt-Assertion 的 RS256 签名（公钥取自团队的 /cdn-cgi/access/certs），
// 再核对 aud/iss/exp，签名不对就是没通过，不存在「配置漏了一处就裸奔」。

const encoder = new TextEncoder();

const JWT_HEADER = "cf-access-jwt-assertion";
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60_000;

export interface AccessAuthEnv {
  /** 团队域，例如 zechuanwangyou.cloudflareaccess.com（不要带 https://）。 */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access 应用的 AUD 标签，在该应用的「应用程序受众 (AUD) 标签」里复制。 */
  ACCESS_AUD?: string;
}

export interface AccessIdentity {
  email: string;
}

interface JwksCache {
  domain: string;
  expiresAt: number;
  keys: Map<string, CryptoKey>;
}

let jwksCache: JwksCache | null = null;
// 测试用：把公钥集指到本地假 Access，避免为了验签逻辑去碰真实团队域。
let certsUrlOverride: string | null = null;

export function setAccessCertsUrlForTests(url: string | null): void {
  certsUrlOverride = url;
  jwksCache = null;
}

function teamDomain(env: AccessAuthEnv): string {
  return (env.ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function audience(env: AccessAuthEnv): string {
  return (env.ACCESS_AUD ?? "").trim();
}

export function accessAuthEnabled(env: AccessAuthEnv): boolean {
  return teamDomain(env).length > 0 && audience(env).length > 0;
}

/**
 * 校验请求里的 Access JWT。
 * 返回 null 表示「没通过」——包括没启用、没带头、签名不对、过期、aud 不匹配。
 */
export async function verifyAccessJwt(
  request: Request,
  env: AccessAuthEnv,
  now = Date.now(),
): Promise<AccessIdentity | null> {
  if (!accessAuthEnabled(env)) return null;

  const token = request.headers.get(JWT_HEADER)?.trim() ?? "";
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = decodeJsonObject(parts[0]);
  const payload = decodeJsonObject(parts[1]);
  if (!header || !payload) return null;

  const algorithm = typeof header.alg === "string" ? header.alg : "";
  const keyId = typeof header.kid === "string" ? header.kid : "";
  if (algorithm !== "RS256" || !keyId) return null;

  const key = await loadSigningKey(teamDomain(env), keyId, now);
  if (!key) return null;

  const signature = base64UrlToBytes(parts[2]);
  if (!signature) return null;

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  // 签名对了还要确认「这是发给这个应用的」，否则别的应用的令牌也能拿来用。
  const aud = payload.aud;
  const expectedAud = audience(env);
  const audOk = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!audOk) return null;

  const expiresAt = Number(payload.exp);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= now) return null;

  const notBefore = Number(payload.nbf);
  if (Number.isFinite(notBefore) && notBefore * 1000 > now + CLOCK_SKEW_MS) return null;

  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  if (issuer !== `https://${teamDomain(env)}`) return null;

  // 没有 email 的令牌（例如某些服务令牌）不认：这里要的是"某个人"，不是"某个客户端"。
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email) return null;
  return { email };
}

async function loadSigningKey(domain: string, keyId: string, now: number): Promise<CryptoKey | null> {
  const cached = jwksCache;
  if (cached && cached.domain === domain && cached.expiresAt > now) {
    return cached.keys.get(keyId) ?? (await refresh(domain, keyId, now));
  }
  return refresh(domain, keyId, now);
}

async function refresh(domain: string, keyId: string, now: number): Promise<CryptoKey | null> {
  if (!domain) return null;
  let keys: Map<string, CryptoKey>;
  try {
    const response = await fetch(certsUrlOverride ?? `https://${domain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { keys?: unknown } | null;
    keys = await importJwks(body?.keys);
  } catch {
    return null;
  }
  if (keys.size === 0) return null;
  jwksCache = { domain, expiresAt: now + JWKS_TTL_MS, keys };
  return keys.get(keyId) ?? null;
}

async function importJwks(raw: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  if (!Array.isArray(raw)) return keys;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    // WebCrypto 的 JsonWebKey 类型里没有 kid，但 Access 的公钥集会带。
    const jwk = entry as JsonWebKey & { kid?: unknown };
    if (typeof jwk.kid !== "string") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // 单个公钥坏掉不影响其它 kid。
    }
  }
  return keys;
}

type JsonObject = Record<string, unknown>;

function decodeJsonObject(segment: string): JsonObject | null {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

function base64UrlToBytes(segment: string): Uint8Array | null {
  if (segment.length === 0) return null;
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
