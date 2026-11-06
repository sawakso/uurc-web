import { Monitor } from "lucide-react";

import type { RemoteControlPageProps } from "../app/remoteControlPageProps.js";
import { RemoteVideoTile } from "./RemoteVideoTile.js";

export function RemoteControlStage({
  hasRemoteVideo,
  inputControlActive,
  onRemoteStageKeyDown,
  onRemoteStageKeyUp,
  onRemoteStageBlur,
  onRemoteStageCompositionEnd,
  onRemoteStageInput,
  onRemoteStagePaste,
  onRemoteStagePointerCancel,
  onRemoteStagePointerDown,
  onRemoteStagePointerMove,
  onRemoteStagePointerUp,
  onRemoteStageWheel,
  onRemoteVideoSample,
  primaryRemoteVideoActive,
  primaryRemoteVideoId,
  remoteStageInputRef,
  remoteStageRef,
  remoteStageViewMode,
  remoteVideoStreams,
  selectedDevice,
  stageStatusLabel,
}: Pick<
  RemoteControlPageProps,
  | "hasRemoteVideo"
  | "inputControlActive"
  | "onRemoteStageKeyDown"
  | "onRemoteStageKeyUp"
  | "onRemoteStageBlur"
  | "onRemoteStageCompositionEnd"
  | "onRemoteStageInput"
  | "onRemoteStagePaste"
  | "onRemoteStagePointerCancel"
  | "onRemoteStagePointerDown"
  | "onRemoteStagePointerMove"
  | "onRemoteStagePointerUp"
  | "onRemoteStageWheel"
  | "onRemoteVideoSample"
  | "primaryRemoteVideoActive"
  | "primaryRemoteVideoId"
  | "remoteStageInputRef"
  | "remoteStageRef"
  | "remoteStageViewMode"
  | "remoteVideoStreams"
  | "selectedDevice"
  | "stageStatusLabel"
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
    >
      {/*
        键盘与输入法的真正落点。浏览器只在可编辑元素上启动输入法合成，
        画面本身是 div，所以把按键/合成事件全部接到这个 1px 透明输入框上
        （不占位、不可见、不接受指针事件，完全不改变画面外观）。
      */}
      <input
        ref={remoteStageInputRef}
        className="stage-input-sink"
        type="text"
        aria-hidden="true"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        tabIndex={-1}
        onKeyDown={onRemoteStageKeyDown}
        onKeyUp={onRemoteStageKeyUp}
        onCompositionEnd={onRemoteStageCompositionEnd}
        onInput={onRemoteStageInput}
        onPaste={onRemoteStagePaste}
        onBlur={onRemoteStageBlur}
      />
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
    </div>
  );
}
