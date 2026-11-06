import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { KeyRound, LoaderCircle, RefreshCw } from "lucide-react";

import { getOwnerSession, loginOwner, type OwnerSession } from "../api/client.js";

type GateState = "checking" | "locked" | "open" | "unconfigured" | "access-blocked";

/**
 * 控制台入口闸门。
 *
 * 这一层只保护「主控台」本身：/share/* 走的是另一条路由，压根不会渲染到这里，
 * 所以访客拿链接打开时不会被要求输入主人的口令，也不会被 Cloudflare Access 拦住。
 *
 * 身份有两种来源，由服务端决定：
 *   - access：Cloudflare Access 已经放行，服务端验过它签发的 JWT，直接进；
 *   - passphrase：没上 Access 时，Worker 自己比对口令并签发 Cookie。
 * 不会出现「Access 登录一次、再输一次口令」的双重门。
 */
export function OwnerGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getOwnerSession()
      .then((next) => {
        if (cancelled) return;
        setSession(next);
        if (next.authenticated) {
          setState("open");
          return;
        }
        if (!next.configured) {
          setState("unconfigured");
          return;
        }
        // Access 模式下没有「输口令」这条路：JWT 没通过就是没通过，只能重新走 Access 登录。
        setState(next.mode === "access" ? "access-blocked" : "locked");
      })
      .catch((caught) => {
        if (cancelled) return;
        // 拿不到登录态就先按"未登录"处理：宁可多输一次口令，也不要在错误状态下放行。
        setError(caught instanceof Error ? caught.message : "无法校验登录态");
        setState("locked");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(): Promise<void> {
    if (busy || password.trim().length === 0) return;
    setBusy(true);
    setError("");
    try {
      await loginOwner(password);
      setPassword("");
      setState("open");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  if (state === "open") return <>{children}</>;

  if (state === "checking") {
    return (
      <main className="product-shell auth-product-shell" aria-label="正在校验访问口令">
        <p className="empty-text">正在校验访问口令…</p>
      </main>
    );
  }

  if (state === "access-blocked") {
    return (
      <main className="product-shell auth-product-shell">
        <section className="login-layout">
          <div className="form-section auth-card" role="alert">
            <h2>Cloudflare Access 没有放行</h2>
            <p className="section-help">
              控制台现在由 Cloudflare Access 保护，这个请求没有带上有效的 Access 身份。
              通常是登录态过期了，刷新一次会重新走邮箱验证码。
            </p>
            {session?.message ? <p className="section-help">{session.message}</p> : null}
            <button type="button" className="primary-action-button" onClick={() => window.location.reload()}>
              <RefreshCw size={15} />
              重新加载并登录
            </button>
            <p className="section-help">
              如果刷新后还是这一页，说明 Access 应用没有覆盖当前路径，或者 Worker 里的
              <code> ACCESS_AUD </code>与该应用不匹配。
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="product-shell auth-product-shell">
      <section className="login-layout">
        <form
          className="form-section auth-card"
          aria-label="登录控制台"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>登录控制台</h2>
          <p className="section-help">
            这是你自己的远控入口，需要一个只有你知道的口令。分享链接不受这里影响，访客用自己的观看口令进入。
          </p>

          {state === "unconfigured" ? (
            <section className="error-strip" role="alert">
              <span>{session?.message || "服务端还没有配置任何登录方式。"}</span>
            </section>
          ) : (
            <>
              <label htmlFor="owner-passphrase">
                <span>访问口令</span>
                <input
                  id="owner-passphrase"
                  name="ownerPassphrase"
                  aria-label="访问口令"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
              </label>
              {error ? (
                <section className="error-strip" role="alert" aria-live="assertive">
                  <span>{error}</span>
                </section>
              ) : null}
              <button type="submit" className="primary-action-button" disabled={busy || password.trim().length === 0}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}
                {busy ? "正在验证…" : "进入控制台"}
              </button>
            </>
          )}
        </form>
      </section>
    </main>
  );
}
