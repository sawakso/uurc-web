import type { RemoteAssistanceControlMode, RoomJoinKind } from "@uurc/shared/types";

import type { BrowserRemoteVideoElementSample } from "../remote/browserRemoteSession.js";

export type BusyAction =
  | "status"
  | "import"
  | "export"
  | "send-mobile-code"
  | "mobile-login"
  | "devices"
  | "assistance"
  | "join"
  | "logout"
  | "signal-start"
  | "signal-stop"
  | "browser-remote-start"
  | "reconnect"
  | "clipboard-read"
  | "signal-events"
  | null;

export type SdpTransportMode = "gzip" | "plain";
export type ConnectionRouteMode = "auto" | "relay";
export type RemoteStageViewMode = "fit" | "fill";

export type RoomJoinContext = {
  kind: RoomJoinKind;
  deviceId: string;
  forceJoin: boolean;
  occupiedAtJoin: boolean;
  connectId?: string;
  connectCodeProvided?: boolean;
  controlId?: string;
  controlMode?: RemoteAssistanceControlMode | null;
  deviceName?: string;
  targetPlatform?: number;
};

export type RemoteVideoStream = {
  id: string;
  stream: MediaStream;
};

export type RemoteVideoSourceInfo = {
  id: string;
  index: number;
  resolution: string;
  hasSignal: boolean;
};

export type RemoteConnectionQualityState = "pending" | "good" | "warn" | "bad";

export type RemoteConnectionQuality = {
  state: RemoteConnectionQualityState;
  title: string;
  detail: string;
  metrics: RemoteConnectionQualityMetric[];
};

export type RemoteConnectionQualityMetric = {
  label: string;
  value: string;
};

export type NextAction = {
  label: string;
  detail: string;
  disabled: boolean;
};

export type RemoteVideoSamplesById = Record<string, BrowserRemoteVideoElementSample>;

export const SELF_DEVICE_BLOCKED_REASON = "不能控制当前设备。";

// 远控输入方式。
// native（默认）：只发物理按键，且本地焦点放在不可编辑的画面上——浏览器只在可编辑元素上
//   启动输入法合成，所以本机输入法完全不介入，字母原样送到被控机，由**被控机自己的输入法**
//   组字出候选。这是"在被控机上打中文"的唯一可行方式。
// text：把字符整段上屏（text_input），大小写精确，但绕过被控端输入法，只能打本机已经上屏的文字。
export type RemoteInputMode = "native" | "text";
