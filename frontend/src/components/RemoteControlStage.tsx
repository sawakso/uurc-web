import { Monitor } from "lucide-react";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { RemoteControlPageProps } from "../app/remoteControlPageProps.js";
import {
  projectToStageLocalCursor,
  readStageMediaLayout,
  type StageMediaLayout,
} from "../remote/remoteControlUiModel.js";
import { RemoteVideoTile } from "./RemoteVideoTile.js";

export function RemoteControlStage({
  hasRemoteVideo,
  inputControlActive,
  localCursorVisible,
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
  | "localCursorVisible"
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
  // 被控端开「隐私屏保」时走的是另一套捕获管线，那套不把指针合成进画面，
  // 于是画面上只剩浏览器自己的黑色十字，看不到鼠标到底在哪。
  // 这里在本地补一个指针（橙紫渐变，和原来被控端画的那个同一个观感），
  // 位置按 toStageLocalCursorPoint 换算——和真正发出去的绝对坐标同一套规则，
  // 所以它落在远端指针本该在的地方，黑边里也会贴边。
  //
  // 直接用 ref 写 transform，不走 setState：pointermove 频率很高，走 React 会让整个
  // 远控页每移动一次就重渲染一遍，手机上会明显掉帧。
  const localCursorRef = useRef<HTMLSpanElement | null>(null);
  // 布局只在按下/换画面源时读一次，pointermove 全部走缓存。
  // 每次移动都调 getBoundingClientRect 会强制同步重排，手机上会把主线程拖慢，
  // 进而拖慢 100ms 的控制心跳，被控端误判主控离线就停推画面。
  const stageLayoutRef = useRef<StageMediaLayout | null>(null);

  function paintLocalCursor(clientX: number, clientY: number) {
    const node = localCursorRef.current;
    const layout = stageLayoutRef.current;
    if (!node || !layout) return;
    const point = projectToStageLocalCursor(layout, clientX, clientY);
    node.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    node.style.opacity = "1";
  }

  // 刚连上时先摆到画面中心：不动鼠标也能看见指针在哪。切画面源后重读布局并重摆一次，
  // 因为不同屏的分辨率不同，内容区会跟着变。
  useEffect(() => {
    const node = localCursorRef.current;
    // 箭头的父节点就是 stage 本身，省得为了拿 DOM 再把 ref 往下传一层。
    const stage = node?.parentElement;
    if (!node || !stage) return;
    const layout = readStageMediaLayout(stage as HTMLDivElement);
    if (!layout) return;
    stageLayoutRef.current = layout;
    node.style.transform = `translate3d(${layout.mediaLeft + layout.mediaWidth / 2}px, ${layout.mediaTop + layout.mediaHeight / 2}px, 0)`;
    node.style.opacity = "1";
  }, [inputControlActive, hasRemoteVideo, localCursorVisible, primaryRemoteVideoId]);

  function syncLocalCursor(event: ReactPointerEvent<HTMLDivElement>) {
    if (!inputControlActive || !hasRemoteVideo || !localCursorVisible) return;
    paintLocalCursor(event.clientX, event.clientY);
  }

  function refreshLocalCursorLayout(event: ReactPointerEvent<HTMLDivElement>) {
    if (!inputControlActive || !hasRemoteVideo || !localCursorVisible) return;
    stageLayoutRef.current = readStageMediaLayout(event.currentTarget);
  }

  return (
    <div
      ref={remoteStageRef}
      className={`remote-stage control-remote-stage remote-stage-${remoteStageViewMode} ${inputControlActive ? "remote-stage-interactive" : ""}`}
      role="application"
      aria-label="远控画面"
      tabIndex={0}
      onKeyDown={onRemoteStageKeyDown}
      onKeyUp={onRemoteStageKeyUp}
      onBlur={onRemoteStageBlur}
      onPaste={onRemoteStagePaste}
      onPointerDown={(event) => {
        onRemoteStagePointerDown(event);
        // 每次按下重读一次布局：页面可能刚滚动过，或视频分辨率刚变。
        refreshLocalCursorLayout(event);
        syncLocalCursor(event);
      }}
      onPointerMove={(event) => {
        onRemoteStagePointerMove(event);
        syncLocalCursor(event);
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

      {/* 本地补偿指针：只在「已解锁输入 + 有画面 + 开关打开」时挂载。 */}
      {inputControlActive && hasRemoteVideo && localCursorVisible ? (
        <span ref={localCursorRef} className="stage-local-cursor" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
            <defs>
              <linearGradient id="stage-local-cursor-fill" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ff9a2e" />
                <stop offset="100%" stopColor="#8a5cff" />
              </linearGradient>
            </defs>
            <path
              d="M0 0 V15 L4 11.3 L6.6 17 L9 15.8 L6.4 10.2 H11 Z"
              fill="url(#stage-local-cursor-fill)"
              stroke="#1b1b1b"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
    </div>
  );
}
