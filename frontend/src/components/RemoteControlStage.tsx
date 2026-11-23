import { Monitor } from "lucide-react";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { RemoteControlPageProps } from "../app/remoteControlPageProps.js";
import { getStageLocalCursorAnchor, toStageLocalCursorPoint } from "../remote/remoteControlUiModel.js";
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
  // 被控端只在部分画面里把指针合成进视频流（黑屏时出现过、画面恢复后又消失），
  // 画面上就时不时完全没有"鼠标在哪"的提示。这里本地画一个常驻箭头代替它：
  // 位置和真正发出去的绝对坐标共用同一套换算（含黑边的 clamp），所以箭头在哪，
  // 远端指针就在哪。
  //
  // 直接用 ref 写 transform，不走 setState：pointermove 频率很高，走 React 会让整个
  // 远控页每移动一次就重渲染一遍，手机上会明显掉帧。
  const localCursorRef = useRef<HTMLSpanElement | null>(null);

  function moveLocalCursor(stage: HTMLDivElement, clientX: number, clientY: number) {
    const node = localCursorRef.current;
    if (!node) return;
    const point = toStageLocalCursorPoint(stage, clientX, clientY);
    if (!point) return;
    node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    node.style.opacity = "1";
  }

  // 刚连上时先摆到画面中心，这样不动鼠标也能看到指针在哪；切画面源后重新摆一次
  // （不同屏的分辨率不同，内容区会跟着变）。
  useEffect(() => {
    const node = localCursorRef.current;
    // 箭头的父节点就是 stage 本身，省得为了拿 DOM 再把 ref 往下传一层。
    const stage = node?.parentElement;
    if (!node || !stage) return;
    const anchor = getStageLocalCursorAnchor(stage as HTMLDivElement);
    if (!anchor) return;
    node.style.transform = `translate3d(${anchor.x}px, ${anchor.y}px, 0)`;
    node.style.opacity = "1";
  }, [inputControlActive, hasRemoteVideo, primaryRemoteVideoId]);

  function handleStagePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!inputControlActive || !hasRemoteVideo) return;
    moveLocalCursor(event.currentTarget, event.clientX, event.clientY);
  }

  return (
    <div
      ref={remoteStageRef}
      className={`remote-stage control-remote-stage remote-stage-${remoteStageViewMode} ${inputControlActive ? "remote-stage-interactive" : ""} ${inputControlActive && hasRemoteVideo ? "remote-stage-showing-local-cursor" : ""}`}
      role="application"
      aria-label="远控画面"
      tabIndex={0}
      onKeyDown={onRemoteStageKeyDown}
      onKeyUp={onRemoteStageKeyUp}
      onBlur={onRemoteStageBlur}
      onPaste={onRemoteStagePaste}
      onPointerDown={(event) => {
        onRemoteStagePointerDown(event);
        handleStagePointer(event);
      }}
      onPointerMove={(event) => {
        onRemoteStagePointerMove(event);
        handleStagePointer(event);
      }}
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
        只在「字符上屏」模式下才用的落点：浏览器只在可编辑元素上启动输入法合成。
        物理按键模式（默认）焦点直接放在上面的画面 div 上——那里不可编辑，本机输入法
        完全不介入，按键原样送去被控机，中文由被控机自己的输入法组字。
        这个输入框 1px 透明、不占位、不接受指针事件，两种模式都不改变画面外观。
        键盘事件统一挂在画面 div 上（事件从输入框冒泡上来），避免两处都处理导致重复发送。
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
        onCompositionEnd={onRemoteStageCompositionEnd}
        onInput={onRemoteStageInput}
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

      {/* 常驻本地指针：只在「已解锁输入 + 有画面」时挂载，避免在占位画面上浮一个箭头。 */}
      {inputControlActive && hasRemoteVideo ? (
        <span ref={localCursorRef} className="stage-local-cursor" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
            <path
              d="M0 0 V15 L4 11.3 L6.6 17 L9 15.8 L6.4 10.2 H11 Z"
              fill="#ffffff"
              stroke="#111111"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
    </div>
  );
}
