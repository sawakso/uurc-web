import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Eye, Lock, Monitor, MousePointer2, Unlock } from "lucide-react";

import { toAndroidKeyCodeFromDomEvent } from "../remote/androidKeyCodes.js";
import { ShareGuestSession, type ShareDiagnostics, type ShareGuestStatus } from "../share/shareGuestSession.js";

interface ShareGuestPageProps {
  shareId: string;
}

/**
 * 访客页：口令 -> 看画面 -> 操作。
 * 画面是主控浏览器转发过来的 WebRTC 流，输入从数据通道回传给主控，
 * 因此访客不需要（也不拥有）UU 账号或房间凭证。
 */
export function ShareGuestPage({ shareId }: ShareGuestPageProps) {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<ShareGuestStatus | "idle">("idle");
  const [message, setMessage] = useState("请输入分享口令");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [diagnostics, setDiagnostics] = useState<ShareDiagnostics | null>(null);
  const [canControl, setCanControl] = useState(false);
  const [controlPassword, setControlPassword] = useState("");
  const [controlNotice, setControlNotice] = useState("");

  const sessionRef = useRef<ShareGuestSession | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const keySinkRef = useRef<HTMLInputElement | null>(null);
  const lastCompositionEnd = useRef(0);

  useEffect(() => {
    const session = new ShareGuestSession({
      onStatus: (next, text) => {
        setStatus(next);
        setMessage(text);
      },
      onStream: (next) => setStream(next),
      onDiagnostics: (next) => setDiagnostics(next),
      onControlChange: (next) => {
        setCanControl(next);
        if (next) {
          setControlNotice("");
          setControlPassword("");
        }
      },
      onNotice: (text) => setControlNotice(text),
    });
    sessionRef.current = session;
    return () => {
      session.close();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [stream]);

  const join = useCallback(() => {
    const session = sessionRef.current;
    if (!session || password.trim().length === 0) return;
    setDiagnostics(null);
    session.connect(shareId, password);
  }, [password, shareId]);

  // ---- 输入 ----

  const sendPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    const surface = surfaceRef.current;
    const video = videoRef.current;
    if (!session || !surface) return;
    const rect = surface.getBoundingClientRect();
    const mediaWidth = video?.videoWidth || rect.width;
    const mediaHeight = video?.videoHeight || rect.height;
    const ratio = mediaWidth / mediaHeight;
    const containerRatio = rect.width / rect.height;
    const renderedWidth = containerRatio > ratio ? rect.height * ratio : rect.width;
    const renderedHeight = containerRatio > ratio ? rect.height : rect.width / ratio;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    const x = Math.min(1, Math.max(0, (event.clientX - left) / renderedWidth));
    const y = Math.min(1, Math.max(0, (event.clientY - top) / renderedHeight));
    session.sendInput({ kind: "move", x, y });
  }, []);

  const focusKeys = useCallback(() => {
    keySinkRef.current?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    const session = sessionRef.current;
    if (!session || event.nativeEvent.isComposing) return;
    if (Date.now() - lastCompositionEnd.current < 150 && event.key === "Enter") {
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "v" || event.key === "V")) {
      // 访客侧粘贴：读本机剪贴板后整段发送。
      event.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) session.sendInput({ kind: "text", text });
        })
        .catch(() => undefined);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      session.sendInput({ kind: "text", text: event.key });
      return;
    }
    const code = toAndroidKeyCodeFromDomEvent(event.nativeEvent);
    if (code === undefined) return;
    event.preventDefault();
    session.sendInput({ kind: "key", code, down: true });
    if (!["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(event.key)) {
      session.sendInput({ kind: "key", code, down: false });
    }
  }, []);

  const handleCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLInputElement>) => {
    lastCompositionEnd.current = Date.now();
    const text = event.data ?? "";
    event.currentTarget.value = "";
    if (!text) return;
    sessionRef.current?.sendInput({ kind: "text", text });
  }, []);

  const statusLabel = useMemo(() => {
    if (status === "connecting") return "正在连接…";
    if (status === "connected") return "已连接";
    return message;
  }, [message, status]);

  return (
    <main className="share-shell">
      <header className="share-header">
        <div className="share-brand">
          <Monitor size={18} />
          <strong>共享画面</strong>
        </div>
        <span className={`share-status share-status--${status}`}>{statusLabel}</span>
      </header>

      {status === "idle" || status === "error" ? (
        <section className="share-gate">
          <Lock size={26} />
          <h1>输入观看口令</h1>
          <p>{status === "error" ? message : "观看口令由发起人提供。拿到后只能看，想操作还需要控制口令。"}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              join();
            }}
          >
            <input
              className="share-password"
              type="password"
              value={password}
              autoFocus
              placeholder="观看口令"
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="primary-action-button" type="submit" disabled={password.trim().length === 0}>
              进入
            </button>
          </form>
        </section>
      ) : (
        <section className="share-stage-wrap">
          <div
            className="share-surface"
            ref={surfaceRef}
            onPointerDown={(event) => {
              if (!canControl) return;
              focusKeys();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              sessionRef.current?.sendInput({ kind: "button", button: event.button, down: true });
            }}
            onPointerUp={(event) => {
              if (!canControl) return;
              sessionRef.current?.sendInput({ kind: "button", button: event.button, down: false });
            }}
            onPointerMove={sendPointerMove}
            onWheel={(event) => {
              event.preventDefault();
              if (!canControl) return;
              sessionRef.current?.sendInput({ kind: "wheel", dx: event.deltaX, dy: event.deltaY });
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <video ref={videoRef} className="share-video" playsInline muted autoPlay />
            <input
              ref={keySinkRef}
              className="share-key-sink"
              aria-hidden="true"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={handleKeyDown}
              onCompositionEnd={handleCompositionEnd}
              onInput={(event) => {
                event.currentTarget.value = "";
              }}
            />
            {!stream || !diagnostics?.decoding ? (
              <div className="share-waiting">
                <MousePointer2 size={22} />
                <span>{statusLabel}</span>
                {diagnostics ? <em className="share-diagnostics">{diagnostics.summary}</em> : null}
              </div>
            ) : null}
          </div>
          {canControl ? (
            <div className="share-control-bar share-control-bar--active">
              <span className="share-control-state">
                <Unlock size={13} />
                你可以操作这台电脑
              </span>
              <span className="share-control-notice">鼠标点击、键盘输入都会直接送到对方电脑。</span>
            </div>
          ) : (
            <div className="share-control-bar">
              <span className="share-control-state">
                <Eye size={13} />
                仅观看
              </span>
              <form
                className="share-control-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (controlPassword.trim().length === 0) return;
                  sessionRef.current?.requestControl(controlPassword);
                  setControlNotice("正在校验控制口令…");
                }}
              >
                <input
                  type="password"
                  className="share-control-input"
                  value={controlPassword}
                  placeholder="控制口令（想操作时输入）"
                  onChange={(event) => setControlPassword(event.target.value)}
                />
                <button className="secondary-button" type="submit" disabled={controlPassword.trim().length === 0}>
                  解锁操作
                </button>
              </form>
              {controlNotice ? <span className="share-control-notice">{controlNotice}</span> : null}
            </div>
          )}
          <div className="share-footer">
            <p className="share-hint">
              {canControl
                ? "点击画面即可操作；输入法上屏后整段送达。关闭主控页面会立即中断分享。"
                : "没有控制口令时只能观看。需要动手就向对方要控制口令，在上面输入即可解锁。"}
            </p>
            <div className="share-footer-side">
              {diagnostics?.decoding ? <span className="share-diagnostics">{diagnostics.summary}</span> : null}
              {status === "connected" || status === "waiting-host" ? (
                <button type="button" className="secondary-button" onClick={join}>
                  重新连接
                </button>
              ) : null}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
