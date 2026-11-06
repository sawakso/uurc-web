import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";

import { getOwnerSession, loginOwner } from "../api/client.js";

type GateState = "checking" | "locked" | "open" | "unconfigured";

/**
 * 控制台入口闸门。
 *
 * 这一层只保护「主控台」本身：/share/* 走的是另一条路由，压根不会渲染到这里，
 * 所以访客拿链接打开时不会被要求输入主人的口令，也不会被 Cloudflare 登录页拦住。
 *
 * 它挡住的攻击面是真实的：Worker 上的 /api/proxy/uu 能代替你访问 UU 接口，
 * /api/remote/* 能驱动远控会话，没有这层门等于把远控能力公开在公网上。
 */
export function OwnerGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getOwnerSession()
      .then((session) => {
        if (cancelled) return;
        if (session.authenticated) {
          setState("open");
          return;
        }
        if (!session.configured) {
          setGuidance(session.message);
          setState("unconfigured");
          return;
        }
        setState("locked");
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
              <span>{guidance || "服务端还没有设置登录口令。"}</span>
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
