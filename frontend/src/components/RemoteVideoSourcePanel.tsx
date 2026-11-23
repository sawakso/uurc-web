import { Monitor } from "lucide-react";

import type { RemoteControlPageProps } from "../app/remoteControlPageProps.js";

export function RemoteVideoSourcePanel({
  displaySlots,
  onDisplaySlotsChange,
  onFlipRemoteScreen,
  onResetScreenRotation,
  onRemoteVideoSourceChange,
  primaryRemoteVideoId,
  remoteVideoSources,
}: Pick<
  RemoteControlPageProps,
  | "displaySlots"
  | "onDisplaySlotsChange"
  | "onFlipRemoteScreen"
  | "onResetScreenRotation"
  | "onRemoteVideoSourceChange"
  | "primaryRemoteVideoId"
  | "remoteVideoSources"
>) {
  const hasSources = remoteVideoSources.length > 0;
  const multiSlotRequested = displaySlots > 1;
  // 已经要了多路却没收到第二路：说明被控端没按槽位推流，跟界面无关，得如实说出来。
  const multiSlotNotHonored = multiSlotRequested && hasSources && remoteVideoSources.length < displaySlots;

  return (
    <section className="control-insight-panel" aria-label="画面源">
      <header>
        <div>
          <Monitor size={17} />
          <h2>画面源</h2>
        </div>
        <span>{hasSources ? `${remoteVideoSources.length} 路` : "等待画面"}</span>
      </header>
      <p>
        {!hasSources ? "连接后显示可用画面" : remoteVideoSources.length > 1 ? "键鼠会跟着发到选中的这块屏" : "选择要显示的画面"}
      </p>
      <div className="video-source-list">
        {hasSources ? (
          remoteVideoSources.map((source) => (
            <button
              type="button"
              key={source.id}
              className={source.hasSignal ? undefined : "video-source-empty"}
              aria-pressed={source.id === primaryRemoteVideoId}
              onClick={() => onRemoteVideoSourceChange(source.id)}
            >
              <span>屏幕 {source.index + 1}</span>
              <small>{source.hasSignal ? source.resolution || "画面中" : "无信号"}</small>
            </button>
          ))
        ) : (
          <span>暂无画面源</span>
        )}
      </div>
      <div className="video-source-slots" role="group" aria-label="显示器路数">
        <button type="button" aria-pressed={!multiSlotRequested} onClick={() => onDisplaySlotsChange(1)}>
          单屏
        </button>
        <button type="button" aria-pressed={multiSlotRequested} onClick={() => onDisplaySlotsChange(2)}>
          多屏 2 路
        </button>
      </div>
      <div className="video-source-slots" role="group" aria-label="切换捕获屏幕">
        <button type="button" onClick={() => onFlipRemoteScreen("prev")}>
          上一块屏
        </button>
        <button type="button" onClick={() => onFlipRemoteScreen("next")}>
          下一块屏
        </button>
        <button type="button" onClick={onResetScreenRotation}>
          转回来
        </button>
      </div>
      <small>
        切屏等同于发送 Ctrl+Alt+←/→。画面若整个转了 90°，按「转回来」（Ctrl+Alt+↑）复位。
      </small>
      {multiSlotRequested ? (
        <small>
          {multiSlotNotHonored
            ? `已请求 ${displaySlots} 路，被控端只推了 ${remoteVideoSources.length} 路 —— 说明它不按槽位推流`
            : `已请求 ${displaySlots} 路，改动在下一次连接生效`}
        </small>
      ) : null}
    </section>
  );
}
