import { Keyboard, Monitor } from "lucide-react";

import type { RemoteControlPageProps } from "../app/remoteControlPageProps.js";
import { RemoteVideoTile } from "./RemoteVideoTile.js";

export function RemoteControlStage({
  browserStageLabel,
  hasRemoteVideo,
  imeInputOpen,
  inputControlActive,
  inputControlLabel,
  onImeInputCompositionEnd,
  onImeInputKeyDown,
  onToggleImeInput,
  onRemoteStageKeyDown,
  onRemoteStageKeyUp,
  onRemoteStageBlur,
  onRemoteStageCompositionEnd,
  onRemoteStagePaste,
  onRemoteStagePointerCancel,
  onRemoteStagePointerDown,
  onRemoteStagePointerMove,
  onRemoteStagePointerUp,
  onRemoteStageWheel,
  onRemoteVideoSample,
  primaryRemoteVideoActive,
  primaryRemoteVideoId,
  remoteStageRef,
  remoteStageViewMode,
  remoteVideoCount,
  remoteVideoStreams,
  selectedDevice,
  stageStatusLabel,
  videoFlowLabel,
}: Pick<
  RemoteControlPageProps,
  | "browserStageLabel"
  | "hasRemoteVideo"
  | "imeInputOpen"
  | "inputControlActive"
  | "inputControlLabel"
  | "onImeInputCompositionEnd"
  | "onImeInputKeyDown"
  | "onToggleImeInput"
  | "onRemoteStageKeyDown"
  | "onRemoteStageKeyUp"
  | "onRemoteStageBlur"
  | "onRemoteStageCompositionEnd"
  | "onRemoteStagePaste"
  | "onRemoteStagePointerCancel"
  | "onRemoteStagePointerDown"
  | "onRemoteStagePointerMove"
  | "onRemoteStagePointerUp"
  | "onRemoteStageWheel"
  | "onRemoteVideoSample"
  | "primaryRemoteVideoActive"
  | "primaryRemoteVideoId"
  | "remoteStageRef"
  | "remoteStageViewMode"
  | "remoteVideoCount"
  | "remoteVideoStreams"
  | "selectedDevice"
  | "stageStatusLabel"
  | "videoFlowLabel"
>) {
  return (
    <div
      ref={remoteStageRef}
      className={`remote-stage control-remote-stage remote-stage-${remoteStageViewMode} ${inputControlActive ? "remote-stage-interactive" : ""}`}
      role="application"
      aria-label="远控画面"
      tabIndex={0}
      onPointerDown={onRemoteStagePointerDown}
      onPointerMove={onRemoteStagePointerMove}
      onPointerUp={onRemoteStagePointerUp}
      onPointerCancel={onRemoteStagePointerCancel}
      onWheel={onRemoteStageWheel}
      onContextMenu={(event) => {
        // 已解锁输入时，拦截浏览器右键菜单：否则原生菜单会吞掉 pointerup，
        // 导致“抬起右键”发不出去、被控端右键卡死、之后左键都被当右键。
        if (inputControlActive) event.preventDefault();
      }}
      onKeyDown={onRemoteStageKeyDown}
      onKeyUp={onRemoteStageKeyUp}
      onBlur={onRemoteStageBlur}
      onPaste={onRemoteStagePaste}
      onCompositionEnd={onRemoteStageCompositionEnd}
    >
      {hasRemoteVideo ? (
        <>
          <div className="remote-video-grid">
            {remoteVideoStreams.map((video, index) => (
              <RemoteVideoTile
                key={video.id}
                videoId={video.id}
                index={index}
                visible={video.id === primaryRemoteVideoId}
                stream={video.stream}
                onVideoSample={onRemoteVideoSample}
              />
            ))}
          </div>
          {!primaryRemoteVideoActive ? (
            <div className="stage-center stage-center--overlay">
              <Monitor size={34} />
              <strong>该画面暂无内容</strong>
              <span>这一路当前没有画面输出，可在右侧「画面源」切换到其他画面。</span>
            </div>
          ) : null}
          <div className="stage-badge">
            {browserStageLabel} · {remoteVideoCount} 路视频 · {videoFlowLabel} · 输入 {inputControlLabel}
          </div>
        </>
      ) : (
        <>
          <div className="stage-grid" />
          <div className="stage-center">
            <Monitor size={34} />
            <strong>{selectedDevice?.alias ?? "未选择设备"}</strong>
            <span>{stageStatusLabel}</span>
          </div>
        </>
      )}
      {inputControlActive ? (
        imeInputOpen ? (
          <div
            className="stage-ime-panel"
            // 输入框在画面之上，指针事件不能外泄给画面，否则点一下输入框就会在远端点击一次。
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <Keyboard size={16} />
            <input
              className="stage-ime-input"
              type="text"
              autoFocus
              aria-label="中文输入框"
              placeholder="用输入法打字，上屏即发送；回车发送，Esc 关闭"
              onCompositionEnd={onImeInputCompositionEnd}
              onKeyDown={onImeInputKeyDown}
            />
            <button type="button" onClick={onToggleImeInput}>
              关闭
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="stage-ime-toggle"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onToggleImeInput}
          >
            <Keyboard size={15} />
            中文输入
          </button>
        )
      ) : null}
    </div>
  );
}
