import type {
  ClipboardEvent,
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  RefObject,
  WheelEvent,
} from "react";

import type {
  RemoteControlBootstrap,
  RemoteSignalGatewayEvent,
  RemoteSignalReadinessDiagnostics,
  RuntimeProfile,
  UuDevice,
  UuParticipantInfo,
} from "@uurc/shared/types";

import type {
  BrowserRemoteSessionState,
  BrowserRemoteVideoElementSample,
} from "../remote/browserRemoteSession.js";
import type { RemoteShortcut } from "../remote/remoteShortcuts.js";
import type { ShareHostController } from "../share/useShareHost.js";
import type {
  BusyAction,
  ConnectionRouteMode,
  RemoteInputMode,
  NextAction,
  RemoteConnectionQuality,
  RemoteStageViewMode,
  RemoteVideoSourceInfo,
  RemoteVideoStream,
  SdpTransportMode,
} from "./remoteControlTypes.js";

export interface RemoteControlPageProps {
  autoSwitchThresholdLabel: string;
  browserIceServers: number;
  browserRemoteState: BrowserRemoteSessionState;
  browserRtcDescription: string;
  browserRtcReady: boolean;
  browserStageLabel: string;
  busy: BusyAction;
  autoReconnectEnabled: boolean;
  autoReconnectLabel: string;
  canDisconnectRemote: boolean;
  canReadLocalClipboard: boolean;
  canReconnectRemote: boolean;
  canSendClipboardText: boolean;
  candidatePairSummary: string;
  clipboardPreviewLabel: string;
  clipboardStatusLabel: string;
  connectionQuality: RemoteConnectionQuality;
  connectionPathLabel: string;
  autoConnect: boolean;
  connectionRouteMode: ConnectionRouteMode;
  controlChannelLabel: string;
  controlChannelState: RTCDataChannelState;
  debugEvents: BrowserRemoteSessionState["debugEvents"];
  deviceNotFound: boolean;
  effectiveConnectionRouteLabel: string;
  error: string;
  forceJoin: boolean;
  hasRemoteVideo: boolean;
  iceControlStatusLabel: string;
  inboundVideoStatsLabel: string;
  inputControlActive: boolean;
  inputControlLabel: string;
  joinModeLabel: string;
  networkSwitchSummary: string;
  nextAction: NextAction;
  normalJoinTakeoverHint: string;
  occupiedBySelfClient: boolean;
  occupyingParticipantLabel: string;
  primaryRemoteVideoActive: boolean;
  primaryRemoteVideoId: string;
  remoteBootstrap: RemoteControlBootstrap | null;
  remoteRecoveryLabel: string;
  remoteShortcutPlatform: string;
  share: ShareHostController;
  remoteStageRef: RefObject<HTMLDivElement | null>;
  // 隐藏输入框：浏览器只给可编辑元素启动输入法，键盘/输入法事件都落在这里。
  remoteStageInputRef: RefObject<HTMLInputElement | null>;
  remoteStageFrameRef: RefObject<HTMLDivElement | null>;
  isFullscreen: boolean;
  remoteStageViewMode: RemoteStageViewMode;
  remoteVideoCount: number;
  remoteVideoSources: RemoteVideoSourceInfo[];
  remoteVideoStreams: RemoteVideoStream[];
  stageStatusLabel: string;
  roomDebugPayload: unknown;
  roomJoinFailureMessage: string;
  roomJoinFailureTakeoverHint: string;
  roomJoinModeDebugLabel: string;
  roomReleaseDetail: string;
  roomReleaseLabel: string;
  roomResponseReady: boolean;
  runtimeProfile: RuntimeProfile | null;
  roomRequiresTakeover: boolean;
  sdpTransportLabel: string;
  sdpTransportMode: SdpTransportMode;
  selectedDevice: UuDevice | null;
  selectedDeviceId: string;
  selectedTargetLabel: string;
  selectedDeviceOccupied: boolean;
  selectedParticipants: UuParticipantInfo[];
  selfDeviceBlockedReason: string;
  serviceRoutePolicyLabel: string;
  signalEvents: RemoteSignalGatewayEvent[];
  signalGatewayDisplay: string;
  signalGatewayErrorHint: string;
  signalHeaderSummary: string;
  signalReadiness: RemoteSignalReadinessDiagnostics;
  signalServerIndex: number;
  signalServerOptions: string[];
  textChannelLabel: string;
  textChannelState: RTCDataChannelState;
  unexpectedSignalEventSummary: string;
  videoElementLabel: string;
  videoFlowLabel: string;
  onAutoConnectChange: (enabled: boolean) => void;
  onConnectionRouteModeChange: (mode: ConnectionRouteMode) => void;
  onAutoReconnectEnabledChange: (enabled: boolean) => void;
  onForceJoinChange: (forceJoin: boolean) => void;
  onNextAction: () => void;
  onReconnectRemote: () => void;
  onRemoteStageKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onRemoteStageKeyUp: (event: KeyboardEvent<HTMLInputElement>) => void;
  onRemoteStageBlur: () => void;
  onRemoteStagePaste: (event: ClipboardEvent<HTMLInputElement>) => void;
  onRemoteStageCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
  onRemoteStageInput: (event: FormEvent<HTMLInputElement>) => void;
  // 输入方式：text = 按字符上屏（大小写/符号精确，配合本机输入法可打中文，默认）；
  // native = 只发物理键，由被控端自己的键盘布局/输入法解释（兜底）。
  inputMode: RemoteInputMode;
  onInputModeChange: (mode: RemoteInputMode) => void;
  onRemoteStagePointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onRemoteStagePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onRemoteStagePointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onRemoteStagePointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onRemoteStageWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onRemoteShortcut: (shortcut: RemoteShortcut) => void;
  onRemoteVideoSourceChange: (videoId: string) => void;
  onRemoteVideoSample: (videoId: string, sample: BrowserRemoteVideoElementSample) => void;
  onReadLocalClipboard: () => void;
  onReturnToDevices: () => void;
  onSdpTransportModeChange: (mode: SdpTransportMode) => void;
  onSignalServerIndexChange: (index: number) => void;
  onStartBrowserRemote: () => void;
  onStartSignalGateway: () => void;
  onStageViewModeChange: (mode: RemoteStageViewMode) => void;
  onStopSignalGateway: () => void;
  onSendClipboardText: () => void;
  onToggleInputControl: () => void;
  onToggleFullscreen: () => void;
}
