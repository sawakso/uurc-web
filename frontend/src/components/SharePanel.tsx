import { useState } from "react";
import { Copy, Share2, X } from "lucide-react";

import type { ShareHostController } from "../share/useShareHost.js";

function randomPassword(): string {
  // 6 位数字口令：足够挡住随手猜，又好念给对面听。用户也可以自己改。
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function SharePanel({ share }: { share: ShareHostController }) {
  const [password, setPassword] = useState(randomPassword);
  const [copied, setCopied] = useState(false);

  const active = share.status !== "idle" && share.status !== "error";

  return (
    <div className="share-panel">
      <button type="button" className="stage-share-trigger" onClick={() => share.setOpen(!share.open)}>
        <Share2 size={14} />
        分享给他人
      </button>

      {share.open ? (
        <div className="share-panel-body" role="dialog" aria-label="分享给他人">
          <div className="share-panel-head">
            <strong>分享画面</strong>
            <button type="button" className="icon-button" aria-label="关闭分享面板" onClick={() => share.setOpen(false)}>
              <X size={15} />
            </button>
          </div>

          {active ? (
            <>
              <label className="control-field">
                <span className="control-field-label">链接（对方打开后输入口令）</span>
                <input className="share-link-input" readOnly value={share.url} onFocus={(event) => event.target.select()} />
              </label>
              <label className="control-field">
                <span className="control-field-label">口令</span>
                <input className="share-link-input" readOnly value={password} />
              </label>
              <div className="share-panel-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(`链接：${share.url}\n口令：${password}`)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                >
                  <Copy size={14} />
                  {copied ? "已复制" : "复制链接和口令"}
                </button>
                <button type="button" className="secondary-button" onClick={share.stop}>
                  停止分享
                </button>
              </div>
              <p className="share-panel-note">
                {share.guests > 0 ? `${share.guests} 人正在观看` : "等待对方加入"}
                {" · "}关闭这个页面会立即中断分享；对方看到的是你当前这一路画面。
              </p>
            </>
          ) : (
            <>
              <label className="control-field">
                <span className="control-field-label">设置一个口令（对方输入后即可观看）</span>
                <input
                  className="share-link-input"
                  value={password}
                  maxLength={64}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <div className="share-panel-actions">
                <button
                  type="button"
                  className="primary-action-button"
                  disabled={share.status === "starting" || password.trim().length < 4}
                  onClick={() => void share.start(password.trim())}
                >
                  {share.status === "starting" ? "创建中…" : "生成分享链接"}
                </button>
              </div>
              <p className="share-panel-note">{share.message || "生成后会得到一条链接，把它和口令一起发给对方。"}</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
