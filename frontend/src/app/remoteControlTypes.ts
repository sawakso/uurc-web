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
// native：只发物理键，由被控端自己的输入法合成——这样才能在被控机上打中文；
// text：把字符整段上屏（text_input），不依赖被控端输入法，但中文无从产生。
export type RemoteInputMode = "native" | "text";
