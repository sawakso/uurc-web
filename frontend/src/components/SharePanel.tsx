import { useState } from "react";
import { Copy, Maximize2, Minimize2, Share2, X } from "lucide-react";

import type { ShareHostController } from "../share/useShareHost.js";

function randomPassword(): string {
  // 6 位数字口令：足够挡住随手猜，又好念给对面听。用户也可以自己改。
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function SharePanel({ share }: { share: ShareHostController }) {
  const [password, setPassword] = useState(randomPassword);
  // 控制口令默认与观看口令不同：只把链接和观看口令给"只想看"的人。
  const [controlPassword, setControlPassword] = useState(randomPassword);
  const [copied, setCopied] = useState(false);
  // 分享面板经常挡着画面。收起后只剩一枚小条，随时可以再展开。
  const [collapsed, setCollapsed] = useState(false);

  const active = share.status !== "idle" && share.status !== "error";

  const copyAll = () => {
    const lines = [`链接：${share.url}`, `观看口令：${password}`];
    if (controlPassword.trim()) lines.push(`控制口令：${controlPassword.trim()}`);
    void navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className={`share-panel${collapsed ? " share-panel--collapsed" : ""}`}>
      {collapsed && active ? (
        <div className="share-panel-mini" role="status">
          <Share2 size={13} />
          <span>分享中</span>
          <span className="share-panel-mini-count">{share.guests} 人在看</span>
          <button type="button" className="icon-button" aria-label="展开分享面板" onClick={() => setCollapsed(false)}>
            <Maximize2 size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="stage-share-trigger"
          onClick={() => {
            setCollapsed(false);
            share.setOpen(!share.open);
          }}
        >
          <Share2 size={14} />
          分享给他人
        </button>
      )}

      {share.open && !collapsed ? (
        <div className="share-panel-body" role="dialog" aria-label="分享给他人">
          <div className="share-panel-head">
            <strong>分享画面</strong>
            <div className="share-panel-head-actions">
              <button
                type="button"
                className="icon-button"
                aria-label="收起分享面板"
                onClick={() => setCollapsed(true)}
              >
                <Minimize2 size={14} />
              </button>
              <button type="button" className="icon-button" aria-label="关闭分享面板" onClick={() => share.setOpen(false)}>
                <X size={15} />
              </button>
            </div>
          </div>

          {active ? (
            <>
              <label className="control-field">
                <span className="control-field-label">链接（对方打开后输入观看口令）</span>
                <input className="share-link-input" readOnly value={share.url} onFocus={(event) => event.target.select()} />
              </label>
              <label className="control-field">
                <span className="control-field-label">观看口令</span>
                <input className="share-link-input" readOnly value={password} />
              </label>
              <label className="control-field">
                <span className="control-field-label">控制口令（只有拿到它的人才能操作鼠标键盘）</span>
                <input className="share-link-input" readOnly value={controlPassword} />
              </label>
              <div className="share-panel-actions">
                <button type="button" className="secondary-button" onClick={copyAll}>
                  <Copy size={14} />
                  {copied ? "已复制" : "复制链接和两个口令"}
                </button>
                <button type="button" className="secondary-button" onClick={share.stop}>
                  停止分享
                </button>
              </div>
              <p className="share-panel-note">
                {share.tracks === 0 ? (
                  <strong>当前没有画面可转发：先连上被控设备、等画面出来再生成链接，否则对方只会看到黑屏。</strong>
                ) : (
                  <>
                    {share.guests > 0 ? `${share.guests} 人正在观看` : "等待对方加入"}
                    {` · 画面已就绪（${share.tracks} 条轨道）`}
                  </>
                )}
                {" · "}只给观看口令的人只能看，动不了你的电脑。
              </p>
            </>
          ) : (
            <>
              <label className="control-field">
                <span className="control-field-label">观看口令（对方输入后即可看画面）</span>
                <input
                  className="share-link-input"
                  value={password}
                  maxLength={64}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="control-field">
                <span className="control-field-label">控制口令（想让他操作鼠标键盘时才给）</span>
                <input
                  className="share-link-input"
                  value={controlPassword}
                  maxLength={64}
                  onChange={(event) => setControlPassword(event.target.value)}
                />
              </label>
              <div className="share-panel-actions">
                <button
                  type="button"
                  className="primary-action-button"
                  disabled={share.status === "starting" || password.trim().length < 4}
                  onClick={() => {
                    // 生成成功后自动收起：面板不该长期占着画面。
                    void share.start(password.trim(), controlPassword.trim()).then(() => setCollapsed(true));
                  }}
                >
                  {share.status === "starting" ? "创建中…" : "生成分享链接"}
                </button>
              </div>
              <p className="share-panel-note">
                {share.message || "生成后会得到一条链接和两个口令：观看口令只能看，控制口令才能操作。"}
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
