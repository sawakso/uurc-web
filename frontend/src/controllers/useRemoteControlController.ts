import type { ClipboardEvent, CompositionEvent, KeyboardEvent, PointerEvent, WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router";

import {
  STREAMER_CONTROL_CONNECT_TYPES,
  STREAMER_DATA_CHANNEL_LABELS,
  analyzeRemoteSignalReadiness,
  buildDefaultStreamerConnectOptionsBase64,
  buildStreamerControlStreamerDataJson,
} from "@uurc/shared/streamerProtocol";
import type {
  AuthStatus,
  RemoteControlBootstrap,
  RemoteSignalGatewayEvent,
  RemoteSignalGatewayStatus,
  RemoteSignalReadinessDiagnostics,
  RuntimeProfile,
  RemoteAssistanceJoinResult,
  RoomJoinResult,
  UuDeviceGroups,
} from "@uurc/shared/types";

import type {
  BusyAction,
  ConnectionRouteMode,
  RemoteInputMode,
  RemoteStageViewMode,
  RemoteVideoSamplesById,
  RemoteVideoSourceInfo,
  RemoteVideoStream,
  RoomJoinContext,
  SdpTransportMode,
} from "../app/remoteControlTypes.js";
import { SELF_DEVICE_BLOCKED_REASON } from "../app/remoteControlTypes.js";
import {
  cancelRemoteAssistance,
  clearAuthState,
  clearRoomByDevice,
  createMobileDevice,
  exportAuthState,
  getAuthStatus,
  getDeviceGroups,
  getRemoteAssistanceControlMode,
  getRemoteBootstrap,
  getRuntimeProfile,
  getRemoteSignalDiagnostics,
  getRemoteSignalEvents,
  importAuthState,
  joinRemoteAssistanceByCode,
  joinRemoteAssistanceByConfirmation,
  joinRoomByDevice,
  loginByMobile,
  sendMobileCode,
  sendRemoteSignalControl,
  sendRemoteSignalSoac,
  startRemoteSignalGateway,
  stopRemoteSignalGateway,
} from "../api/client.js";
import type { RemoteControlPageProps } from "../app/remoteControlPageProps.js";
import { readLocalClipboardText } from "../browser/clipboard.js";
import { formatParticipantMeta } from "../devices/deviceLabels.js";
import { pickControllableDesktop } from "../devices/deviceSummary.js";
import { BrowserRemoteSession, type BrowserRemoteSessionState, type BrowserRemoteVideoElementSample } from "../remote/browserRemoteSession.js";
import { remoteShortcutGroupTitleForPlatform, sendRemoteShortcut, type RemoteShortcut } from "../remote/remoteShortcuts.js";
import {
  createAppControlId,
  createIdleBrowserRemoteState,
  createSingleTrackMediaStream,
  formatAutoSwitchThresholds,
  formatBrowserRemoteStage,
  formatConnectionPath,
  formatDataChannelState,
  getRemoteConnectionQuality,
  formatInboundVideoStats,
  formatRemoteAssistanceMode,
  formatRoomJoinContext,
  formatRoomReleaseDetail,
  formatRoomReleaseState,
  formatSignalGatewayErrorHint,
  formatSignalGatewayState,
  formatVideoElement,
  formatVideoFlow,
  getNextAction,
  getRoomJoinFailureMessage,
  getRoomJoinFailureTakeoverHint,
  resolvePrimaryRemoteVideoId,
  summarizeRoomJoinUpstream,
  summarizeSwitchNetworkNotify,
  summarizeUnexpectedSignalEvents,
  toRemoteKeyValue,
  toRemoteMouseButton,
  toRemoteMousePosition,
} from "../remote/remoteControlUiModel.js";
import { useAutoLoadDevices } from "./useAutoLoadDevices.js";
import { useShareHost } from "../share/useShareHost.js";
import type { ShareInputEvent } from "@uurc/shared/shareProtocol";

const REMOTE_ASSISTANCE_DEFAULT_TARGET_PLATFORM = 1;

// 需要“按住保持”的修饰键(用于组合键);其余键采用瞬时一击。event.key 取值见 KeyboardEvent.key 规范。
const HOLD_MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

function readAutoConnectPref(): boolean {
  try {
    return globalThis.localStorage?.getItem("uurc.autoConnect") !== "false";
  } catch {
    return true;
  }
}

// 输入方式偏好：默认 native（发物理键，由被控机自己的输入法组字，能打中文）。
// 键名带 v2：旧版本默认存过 "text"，沿用老键会让老用户永远停在绕开输入法的那条路上。
const INPUT_MODE_STORAGE_KEY = "uurc.inputMode.v2";

function readInputModePref(): RemoteInputMode {
  try {
    const saved = globalThis.localStorage?.getItem(INPUT_MODE_STORAGE_KEY);
    return saved === "text" ? "text" : "native";
  } catch {
    return "native";
  }
}

function writeInputModePref(mode: RemoteInputMode): void {
  try {
    globalThis.localStorage?.setItem(INPUT_MODE_STORAGE_KEY, mode);
  } catch {
    // 隐私模式下写不进去也无所谓，本次会话内仍生效。
  }
}

// 把底层/协议级英文错误映射成用户能看懂、带“怎么办”的中文；未知错误原样返回。
function toFriendlyError(message: string): string {
  const text = message || "";
  if (/Unexpected token|not valid JSON|Unexpected end of JSON|JSON at position/i.test(text)) return "登录态 JSON 格式不正确，请检查是否完整复制。";
  if (/Join a room before starting remote control|请先加入房间/i.test(text)) return "请先加入设备房间再开始远控。";
  if (/ack timed out|timed out|timeout/i.test(text)) return "连接超时，请稍后重试。";
  if (/signal control ack failed/i.test(text)) return "对端拒绝了本次连接，请稍后重试或更换网络。";
  if (/did not include a ControlResult/i.test(text)) return "未收到对端的连接许可，请重试。";
  if (/socket is not connected|is not connected|not open/i.test(text)) return "连接服务未就绪，请重新连接。";
  if (/Failed to fetch|NetworkError|ERR_NETWORK|network error/i.test(text)) return "网络异常，请检查网络后重试。";
  if (/Missing required login state/i.test(text)) return "登录态不完整，请重新登录。";
  return text;
}

// 手机号前端预校验：中国大陆区号要求 11 位、以 1 开头；其他区号只做非空+纯数字的宽松校验。
function isValidMobileNumber(regionCode: string, mobile: string): boolean {
  const digits = mobile.trim();
  if (!/^\d+$/.test(digits)) return false;
  const region = regionCode.trim() || "86";
  if (region === "86") return /^1\d{10}$/.test(digits);
  return digits.length >= 5 && digits.length <= 15;
}

export function useRemoteControlController() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authJson, setAuthJson] = useState("");
  const [regionCode, setRegionCode] = useState("86");
  const [mobile, setMobile] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [loginNotice, setLoginNotice] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [smsCountdown, setSmsCountdown] = useState(0);
  const [devices, setDevices] = useState<UuDeviceGroups>({ desktopDevices: [], mobileDevices: [], tvDevices: [] });
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [selectedDeviceIdState, setSelectedDeviceId] = useState("");
  const [forceJoin, setForceJoin] = useState(false);
  const [assistanceConnectId, setAssistanceConnectId] = useState("");
  const [assistanceConnectCode, setAssistanceConnectCode] = useState("");
  const [assistanceNotice, setAssistanceNotice] = useState("");
  const [assistanceTargetPlatform, setAssistanceTargetPlatform] = useState<number>(REMOTE_ASSISTANCE_DEFAULT_TARGET_PLATFORM);
  const [roomResponse, setRoomResponse] = useState<RoomJoinResult | null>(null);
  const [roomJoinContext, setRoomJoinContext] = useState<RoomJoinContext | null>(null);
  const [signalGatewayContext, setSignalGatewayContext] = useState<RoomJoinContext | null>(null);
  const [remoteBootstrap, setRemoteBootstrap] = useState<RemoteControlBootstrap | null>(null);
  const [signalGatewayStatus, setSignalGatewayStatus] = useState<RemoteSignalGatewayStatus | null>(null);
  const [signalEvents, setSignalEvents] = useState<RemoteSignalGatewayEvent[]>([]);
  const [remoteSignalDiagnostics, setRemoteSignalDiagnostics] = useState<RemoteSignalReadinessDiagnostics | null>(null);
  const [runtimeProfile, setRuntimeProfile] = useState<RuntimeProfile | null>(null);
  const [browserRemoteState, setBrowserRemoteState] = useState<BrowserRemoteSessionState>(createIdleBrowserRemoteState);
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<RemoteVideoStream[]>([]);
  const [remoteVideoSamplesById, setRemoteVideoSamplesById] = useState<RemoteVideoSamplesById>({});
  const [selectedRemoteVideoId, setSelectedRemoteVideoId] = useState("");
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardStatus, setClipboardStatus] = useState("尚未读取本机剪贴板");
  const [autoReconnectEnabled, setAutoReconnectEnabled] = useState(true);
  const [autoReconnectAttemptCount, setAutoReconnectAttemptCount] = useState(0);
  const [decodeStalledStreak, setDecodeStalledStreak] = useState(0);
  const [autoReconnectStatus, setAutoReconnectStatus] = useState("");
  const [inputControlEnabled, setInputControlEnabled] = useState(false);
  const [sdpTransportMode, setSdpTransportMode] = useState<SdpTransportMode>("gzip");
  const [connectionRouteMode, setConnectionRouteMode] = useState<ConnectionRouteMode>("auto");
  const [autoConnect, setAutoConnect] = useState<boolean>(readAutoConnectPref);
  const [inputMode, setInputMode] = useState<RemoteInputMode>(readInputModePref);
  const [remoteStageViewMode, setRemoteStageViewMode] = useState<RemoteStageViewMode>("fit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [signalServerIndex, setSignalServerIndex] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<BusyAction>("status");
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const toastIdRef = useRef(0);
  const browserRemoteSession = useRef<BrowserRemoteSession | null>(null);
  const remoteStageRef = useRef<HTMLDivElement | null>(null);
  const remoteStageInputRef = useRef<HTMLInputElement | null>(null);
  const remoteStageFrameRef = useRef<HTMLDivElement | null>(null);
  const autoConnectAttemptedDeviceRef = useRef<string>("");
  const controlChannelOpenedRef = useRef(false);
  const activePointerId = useRef<number | null>(null);
  // 记录最近一次输入法上屏的时间与文本，用于压掉浏览器随后补发的重复 keydown。
  const lastCompositionEndAt = useRef(0);
  const lastCompositionText = useRef("");
  const navigate = useNavigate();
  const controlRouteMatch = useMatch("/devices/:deviceId/control");
  const routeSelectedDeviceId = controlRouteMatch?.params.deviceId ?? "";

  const allDevices = useMemo(
    () => [...devices.desktopDevices, ...devices.mobileDevices, ...devices.tvDevices],
    [devices.desktopDevices, devices.mobileDevices, devices.tvDevices],
  );
  const selectedDeviceId = routeSelectedDeviceId || selectedDeviceIdState;

  const selectedDevice = useMemo(
    () => allDevices.find((device) => device.deviceId === selectedDeviceId) ?? null,
    [allDevices, selectedDeviceId],
  );
  const localSignalReadiness = useMemo(
    () =>
      analyzeRemoteSignalReadiness({
        events: signalEvents,
        signalStatus: signalGatewayStatus,
      }),
    [signalEvents, signalGatewayStatus],
  );
  const signalReadiness = remoteSignalDiagnostics ?? localSignalReadiness;
  const selectedParticipants = selectedDevice?.participantsInfo ?? [];
  const selectedDeviceOccupied = selectedParticipants.length > 0;
  // 用 participant.clientId 与当前网页控制端的 clientId 比对，区分“占用者是不是自己上一个会话”。
  // 仅当占用者全部是自己时才自动接管；任一占用者是他人则保留显式接管步骤（避免误踢真实控制端）。
  const currentClientId = authStatus?.clientId ?? "";
  const occupiedBySelfClient =
    selectedParticipants.length > 0 &&
    currentClientId.length > 0 &&
    selectedParticipants.every((participant) => participant.clientId === currentClientId);
  const occupiedByOthers = selectedParticipants.some(
    (participant) => !participant.clientId || participant.clientId !== currentClientId,
  );
  const occupyingParticipant =
    selectedParticipants.find((participant) => !participant.clientId || participant.clientId !== currentClientId) ??
    selectedParticipants[0] ??
    null;
  const occupyingParticipantLabel = occupyingParticipant
    ? occupyingParticipant.alias
      ? `${occupyingParticipant.alias}（${formatParticipantMeta(occupyingParticipant)}）`
      : formatParticipantMeta(occupyingParticipant) || "其他控制端"
    : "其他控制端";
  const primaryRemoteVideoId = useMemo(
    () => resolvePrimaryRemoteVideoId(remoteVideoStreams, remoteVideoSamplesById, selectedRemoteVideoId),
    [remoteVideoSamplesById, remoteVideoStreams, selectedRemoteVideoId],
  );

  // 分享：把当前这一路画面转给访客，并把访客的输入回放进这条控制通道。
  const primaryRemoteStream = useMemo(
    () => remoteVideoStreams.find((video) => video.id === primaryRemoteVideoId)?.stream ?? null,
    [primaryRemoteVideoId, remoteVideoStreams],
  );
  const share = useShareHost({
    getStream: () => primaryRemoteStream,
    onInput: (event) => applyShareInput(event),
  });

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在挂载时恢复一次登录态
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      setToast((current) => (current && current.id === toast.id ? null : current));
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const smsCounting = smsCountdown > 0;
  useEffect(() => {
    if (!smsCounting) return;
    const timer = window.setInterval(() => setSmsCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [smsCounting]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const serverCount = remoteBootstrap?.signalServers.length ?? 0;
    if (serverCount > 0 && signalServerIndex >= serverCount) {
      setSignalServerIndex(0);
    }
  }, [remoteBootstrap?.signalServers.length, signalServerIndex]);

  useEffect(() => {
    if (signalGatewayStatus?.status !== "connected" || browserRemoteState.stage === "idle") return;

    let stopped = false;
    let syncing = false;
    const sync = async () => {
      if (stopped || syncing || !browserRemoteSession.current) return;
      syncing = true;
      try {
        await applyLatestSignalEvents();
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        syncing = false;
      }
    };

    void sync();
    // 建链阶段（answer/ICE 尚未就绪）加快轮询，更快应用信令、缩短连接耗时；
    // 连上后回到 1.5s 稳态，避免稳定期不必要的请求与重渲染。
    const intervalMs = browserRemoteState.stage === "connected" ? 1500 : 600;
    const timer = window.setInterval(sync, intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [signalGatewayStatus?.status, browserRemoteState.stage]);

  async function run(action: BusyAction, task: () => Promise<void>) {
    setBusy(action);
    setError("");
    try {
      await task();
    } catch (caught) {
      setError(toFriendlyError(caught instanceof Error ? caught.message : String(caught)));
      // 远程协助失败时清除“等待对方确认…”等瞬态提示，避免与错误条同时显示矛盾信息
      if (action === "assistance") setAssistanceNotice("");
    } finally {
      setBusy(null);
    }
  }

  function showToast(message: string) {
    if (!message) return;
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message });
  }

  async function loadStatus() {
    await run("status", async () => {
      const [status, runtime] = await Promise.all([
        getAuthStatus(),
        getRuntimeProfile().catch(() => null),
      ]);
      setAuthStatus(status);
      setRuntimeProfile(runtime);
    });
  }

  async function handleImport() {
    await run("import", async () => {
      const status = await importAuthState(authJson);
      setAuthStatus(status);
      if (!status.hasState) {
        const fieldLabels: Record<string, string> = { token: "令牌", userId: "用户 ID", deviceId: "设备 ID" };
        const missing = (status.missingFields ?? []).map((field) => fieldLabels[field] ?? field).join("、");
        throw new Error(missing ? `导入失败：登录态缺少 ${missing}` : "导入失败：登录态不完整");
      }
      setLoginNotice("已导入");
      setDevicesLoaded(false);
      navigate("/devices", { replace: true });
    });
  }

  async function handleExport() {
    await run("export", async () => {
      const state = await exportAuthState();
      setAuthJson(JSON.stringify(state, null, 2));
      showToast("已生成登录态备份，请妥善保管");
    });
  }

  async function handleCopyAuthJson() {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!authJson.trim()) return;
    if (!clipboard?.writeText) {
      showToast("当前环境不支持自动复制，请手动选择文本复制");
      return;
    }
    try {
      await clipboard.writeText(authJson);
      showToast("已复制登录态到剪贴板");
    } catch {
      showToast("复制失败，请手动选择文本复制");
    }
  }

  async function handleLogout() {
    if (typeof window !== "undefined" && !window.confirm("退出后需重新登录。若未导出登录态备份，建议先导出。确定退出？")) {
      return;
    }
    await run("logout", async () => {
      resetBrowserRemoteSession();
      setAuthStatus(await clearAuthState());
      setAuthJson("");
      setDevices({ desktopDevices: [], mobileDevices: [], tvDevices: [] });
      setDevicesLoaded(false);
      setSelectedDeviceId("");
      setForceJoin(false);
      setAssistanceConnectId("");
      setAssistanceConnectCode("");
      setAssistanceNotice("");
      setAssistanceTargetPlatform(REMOTE_ASSISTANCE_DEFAULT_TARGET_PLATFORM);
      setRoomResponse(null);
      setRoomJoinContext(null);
      setSignalGatewayContext(null);
      setRemoteBootstrap(null);
      setSignalGatewayStatus(null);
      setSignalEvents([]);
      setRemoteSignalDiagnostics(null);
      setLoginNotice("");
      setCodeSent(false);
      setSmsCountdown(0);
      navigate("/login", { replace: true });
    });
  }

  async function ensureMobileDevice() {
    if (authStatus?.deviceId) return;
    const result = await createMobileDevice();
    setAuthStatus(result.status);
  }

  async function handleSendMobileCode() {
    await run("send-mobile-code", async () => {
      if (!isValidMobileNumber(regionCode, mobile)) {
        throw new Error(regionCode.trim() === "86" || !regionCode.trim() ? "请输入 11 位有效手机号。" : "请输入有效的手机号。");
      }
      await ensureMobileDevice();
      const result = await sendMobileCode({ regionCode: regionCode.trim() || "86", mobile });
      setAuthStatus(result.status);
      setCodeSent(true);
      setSmsCountdown(60);
      setLoginNotice("验证码已发送");
    });
  }

  async function handleMobileLogin() {
    await run("mobile-login", async () => {
      await ensureMobileDevice();
      const result = await loginByMobile({ regionCode: regionCode.trim() || "86", mobile, code: smsCode });
      setAuthStatus(result.status);
      setLoginNotice("已登录");
      setDevicesLoaded(false);
      navigate("/devices", { replace: true });
    });
  }

  async function loadDevices() {
    await run("devices", async () => {
      const nextDevices = await getDeviceGroups();
      setDevices(nextDevices);
      setDevicesLoaded(true);
      const target = pickControllableDesktop(nextDevices.desktopDevices, authStatus?.deviceId);
      setSelectedDeviceId(target?.deviceId ?? nextDevices.desktopDevices[0]?.deviceId ?? "");
    });
  }

  async function handleOpenDevice(deviceId: string) {
    setSelectedDeviceId(deviceId);
    navigate(`/devices/${encodeURIComponent(deviceId)}/control`);
  }

  async function handleStartRemoteAssistance() {
    if (busy !== null) return;
    if (!loggedIn) {
      setError("远程协助需要先登录 UU 账号。");
      return;
    }

    setAssistanceNotice("");
    await run("assistance", async () => {
      const connectId = assistanceConnectId.trim();
      const connectCode = assistanceConnectCode.trim();
      const modeResult = await getRemoteAssistanceControlMode(connectId);
      if (modeResult.upstream.body.code !== undefined && modeResult.upstream.body.code !== 0) {
        throw new Error(modeResult.upstream.body.msg ?? `远程协助模式返回 ${modeResult.upstream.body.code}`);
      }
      if (!modeResult.canRemoteControl) {
        throw new Error("伙伴设备当前不允许远程协助");
      }
      if (!modeResult.controlMode) {
        throw new Error("伙伴设备未返回可识别的验证方式");
      }

      let joined: RemoteAssistanceJoinResult;
      if (connectCode) {
        joined = await joinRemoteAssistanceByCode({
          connectId,
          connectCode,
          controlMode: modeResult.controlMode,
          targetPlatform: assistanceTargetPlatform,
        });
        if (!joined.roomConfigSummary && joined.assistance.confirmationRequired) {
          setAssistanceNotice("伙伴设备要求二次确认，正在等待对方确认...");
          joined = await joinRemoteAssistanceByConfirmation({
            connectId,
            connectCode,
            controlId: joined.assistance.controlId,
            controlMode: modeResult.controlMode,
            targetPlatform: assistanceTargetPlatform,
          });
        }
      } else if (modeResult.controlMode === "by_confirmation" || modeResult.controlMode === "password_confirmation") {
        setAssistanceNotice("正在等待伙伴设备确认...");
        joined = await joinRemoteAssistanceByConfirmation({
          connectId,
          controlMode: modeResult.controlMode,
          targetPlatform: assistanceTargetPlatform,
        });
      } else {
        throw new Error("伙伴设备当前要求输入设备验证码");
      }

      if (!joined.roomConfigSummary) {
        throw new Error(joined.upstream.body.msg ?? "远程协助未返回可用房间配置");
      }

      const context: RoomJoinContext = {
        kind: "remote_assistance",
        deviceId: joined.assistance.connectId,
        forceJoin: false,
        occupiedAtJoin: false,
        connectId: joined.assistance.connectId,
        connectCodeProvided: joined.assistance.connectCodeProvided,
        controlId: joined.assistance.controlId,
        controlMode: joined.assistance.controlMode,
        deviceName: joined.assistance.deviceName,
        targetPlatform: joined.assistance.targetPlatform ?? assistanceTargetPlatform,
      };
      setSelectedDeviceId(joined.assistance.connectId);
      setRoomResponse(joined);
      setRoomJoinContext(context);
      setForceJoin(false);
      setSignalGatewayContext(null);
      setSignalGatewayStatus(null);
      setSignalEvents([]);
      setRemoteSignalDiagnostics(null);
      resetBrowserRemoteSession();
      setRemoteBootstrap(await getRemoteBootstrap());
      setAssistanceNotice(`已进入远程协助：${formatRemoteAssistanceMode(modeResult.controlMode)}`);
      navigate(`/devices/${encodeURIComponent(joined.assistance.connectId)}/control`);
    });
  }

  async function joinRoomForDevice(deviceId: string, joinWithForce = forceJoin): Promise<RoomJoinContext | null> {
    if (!deviceId) return null;
    let nextContext: RoomJoinContext | null = null;
    await run("join", async () => {
      if (deviceId === authStatus?.deviceId) {
        throw new Error(SELF_DEVICE_BLOCKED_REASON);
      }
      const device = allDevices.find((item) => item.deviceId === deviceId) ?? null;
      const context = {
        kind: "owned_device" as const,
        deviceId,
        forceJoin: joinWithForce,
        occupiedAtJoin: (device?.participantsInfo?.length ?? 0) > 0,
      };
      const joined = await joinRoomByDevice(deviceId, joinWithForce);
      setRoomResponse(joined);
      setRoomJoinContext(context);
      setForceJoin(joinWithForce);
      setSignalGatewayContext(null);
      setSignalGatewayStatus(null);
      setSignalEvents([]);
      setRemoteSignalDiagnostics(null);
      setAssistanceNotice("");
      resetBrowserRemoteSession();
      setRemoteBootstrap(joined.roomConfigSummary ? await getRemoteBootstrap() : null);
      // 房间加入失败（无房间配置）时不返回上下文：让 handleNextAction 就此停下，
      // 由 roomJoinFailureMessage 展示友好中文提示，避免后续信令启动抛出英文异常。
      if (joined.roomConfigSummary) nextContext = context;
    });
    return nextContext;
  }

  async function handleStartSignalGateway(context = roomJoinContext): Promise<RemoteSignalGatewayStatus | null> {
    let nextStatus: RemoteSignalGatewayStatus | null = null;
    await run("signal-start", async () => {
      if (!context || context.deviceId !== selectedDeviceId) {
        throw new Error("请先加入房间");
      }
      const status = await startRemoteSignalGateway({
        gzipSdp: sdpTransportMode === "gzip",
        signalServerIndex: signalServerIndex > 0 ? signalServerIndex : undefined,
      });
      nextStatus = status;
      setSignalGatewayStatus(status);
      setSignalGatewayContext(status.status === "connected" ? context : null);
      setRemoteSignalDiagnostics(await getRemoteSignalDiagnostics());
    });
    return nextStatus;
  }

  async function handleStopSignalGateway() {
    await run("signal-stop", async () => {
      resetBrowserRemoteSession();
      const stopped = await stopRemoteSignalGateway();
      let nextStatus = stopped;
      const clearContext = roomJoinContext;
      if (clearContext?.deviceId) {
        try {
          nextStatus = {
            ...stopped,
            roomClear: clearContext.kind === "remote_assistance"
              ? await cancelRemoteAssistance(clearContext.connectId ?? clearContext.deviceId)
              : await clearRoomByDevice(clearContext.deviceId),
            updatedAt: new Date().toISOString(),
          };
        } catch (caught) {
          nextStatus = {
            ...stopped,
            roomClearError: caught instanceof Error ? caught.message : String(caught),
            updatedAt: new Date().toISOString(),
          };
        }
      }
      setSignalGatewayStatus(nextStatus);
      setSignalGatewayContext(null);
      setRemoteSignalDiagnostics(null);
      showToast("已断开远控连接");
      if (nextStatus.roomClear && (nextStatus.roomClear.body.code === undefined || nextStatus.roomClear.body.code === 0)) {
        setRoomJoinContext((current) => current ? { ...current, occupiedAtJoin: false } : current);
      }
      if (clearContext?.kind !== "remote_assistance") {
        try {
          setDevices(await getDeviceGroups());
        } catch {
          // Disconnect should still complete even if the follow-up device refresh fails.
        }
      }
    });
  }

  async function handleReturnToDevices() {
    if (busy !== null) return;
    // 仅在确有可断开的活动连接时才二次确认；已手动断开（canDisconnectRemote 为 false）后直接返回，
    // 不再因残留的 roomJoinContext 误弹“将断开远控”确认框。
    const hasActiveSession = canDisconnectRemote;
    if (hasActiveSession) {
      const message =
        roomJoinContext?.kind === "remote_assistance"
          ? "返回将断开当前远控并取消本次远程协助，确定返回？"
          : "返回将断开当前远控并释放 UU 房间占用，确定返回？";
      if (typeof window !== "undefined" && !window.confirm(message)) return;
      await handleStopSignalGateway();
    }
    navigate("/devices");
  }

  function resetBrowserRemoteSession() {
    const closedState = browserRemoteSession.current?.close();
    browserRemoteSession.current = null;
    activePointerId.current = null;
    setInputControlEnabled(false);
    setRemoteVideoStreams([]);
    setRemoteVideoSamplesById({});
    setBrowserRemoteState(closedState ?? createIdleBrowserRemoteState());
  }

  async function startBrowserRemoteSession(options: { skipReadinessCheck?: boolean; forceRelay?: boolean } = {}) {
    if (!authStatus?.deviceId) throw new Error("登录已失效");
    if (!selectedDeviceId) throw new Error("请选择设备");
    if (!options.skipReadinessCheck && !roomReadyForBrowserRtc) throw new Error(browserRtcBlockedReason);
    setInputControlEnabled(false);
    const appControlId = createAppControlId();
    const session = new BrowserRemoteSession({
      api: {
        sendSignalControl: sendRemoteSignalControl,
        sendSignalSoac: sendRemoteSignalSoac,
      },
      onRemoteStream: handleRemoteMediaStream,
      onRemoteClipboard: handleRemoteClipboard,
      onStateChange: setBrowserRemoteState,
    });
    browserRemoteSession.current = session;
    const controlConnectType = roomJoinContext?.kind === "remote_assistance"
      ? STREAMER_CONTROL_CONNECT_TYPES.ControlConnectType_Assistance
      : STREAMER_CONTROL_CONNECT_TYPES.ControlConnectType_Normal;
    const state = await session.start({
      appControlId,
      appDataBase64: buildDefaultStreamerConnectOptionsBase64({
        deviceId: authStatus.deviceId,
        controlConnectType,
      }),
      streamerData: buildStreamerControlStreamerDataJson({ controlId: appControlId }),
      forceRelay: options.forceRelay ?? (connectionRouteMode === "relay" ? true : undefined),
      gzipSdp: sdpTransportMode === "gzip",
      targetPlatform: resolveTargetPlatform(),
    });
    setBrowserRemoteState(state);
    await applyLatestSignalEvents(session);
  }

  async function handleStartBrowserRemote(options: { skipReadinessCheck?: boolean } = {}) {
    await run("browser-remote-start", async () => {
      await startBrowserRemoteSession(options);
    });
  }

  async function handleReconnectRemote() {
    await run("reconnect", async () => {
      resetBrowserRemoteSession();
      // 自动切换方案：默认“自动路径”多次重连仍失败时，升级为强制 UU 中转以提升成功率。
      const escalateRelay = connectionRouteMode === "auto" && autoReconnectAttemptCount >= 2;
      if (!signalGatewayMatchesRoom) {
        const status = await startRemoteSignalGateway({
          gzipSdp: sdpTransportMode === "gzip",
          signalServerIndex: signalServerIndex > 0 ? signalServerIndex : undefined,
        });
        setSignalGatewayStatus(status);
        setSignalGatewayContext(status.status === "connected" ? roomJoinContext : null);
        setRemoteSignalDiagnostics(await getRemoteSignalDiagnostics());
        if (status.status !== "connected") {
          throw new Error(formatSignalGatewayErrorHint(status) || "连接服务未启动");
        }
      }
      if (typeof RTCPeerConnection !== "undefined") {
        await startBrowserRemoteSession({ skipReadinessCheck: true, forceRelay: escalateRelay ? true : undefined });
      }
    });
  }

  async function applyLatestSignalEvents(session = browserRemoteSession.current) {
    const events = await getRemoteSignalEvents();
    const diagnostics = await getRemoteSignalDiagnostics();
    setSignalEvents(events);
    setRemoteSignalDiagnostics(diagnostics);
    if (session) {
      await session.applySignalEvents(events);
      await session.refreshConnectionStats();
      setBrowserRemoteState(session.getState());
    }
  }

  async function handleNextAction() {
    if (busy !== null) return;
    if (!loggedIn) {
      setError("请先登录");
      return;
    }
    if (!selectedDeviceId || (deviceTotal === 0 && roomJoinContext?.kind !== "remote_assistance")) {
      await loadDevices();
      return;
    }
    if (!roomJoinedForSelectedDevice || roomRequiresTakeover || signalGatewayState === "error") {
      // 自己上一个会话占用时直接接管（force），无需用户再点一次；他人占用仍保留显式两步。
      const joinWithForce = roomRequiresTakeover || occupiedBySelfClient ? true : forceJoin;
      const nextContext = await joinRoomForDevice(selectedDeviceId, joinWithForce);
      if (!nextContext || (nextContext.occupiedAtJoin && !nextContext.forceJoin)) return;
      const status = await handleStartSignalGateway(nextContext);
      if (status?.status === "connected" && typeof RTCPeerConnection !== "undefined") {
        await handleStartBrowserRemote({ skipReadinessCheck: true });
      }
      return;
    }
    if (!signalGatewayMatchesRoom) {
      const status = await handleStartSignalGateway();
      if (status?.status === "connected" && typeof RTCPeerConnection !== "undefined") {
        await handleStartBrowserRemote({ skipReadinessCheck: true });
      }
      return;
    }
    if (browserRemoteState.stage === "idle") {
      await handleStartBrowserRemote();
      return;
    }
    if (browserConnectionRecoverable) {
      await handleReconnectRemote();
      return;
    }
    if (!inputControlActive && controlChannelState === "open") {
      setInputControlEnabled(true);
      focusStageInput();
      return;
    }
  }

  function handleRemoteMediaStream(stream: MediaStream) {
    const tracks = typeof stream.getVideoTracks === "function" ? stream.getVideoTracks() : [];
    setRemoteVideoStreams(
      tracks.map((track, index) => ({
        id: track.id || `video-${index + 1}`,
        stream: createSingleTrackMediaStream(track),
      })),
    );
    setRemoteVideoSamplesById({});
  }

  const handleRemoteVideoSample = useCallback((videoId: string, sample: BrowserRemoteVideoElementSample) => {
    setRemoteVideoSamplesById((current) => ({ ...current, [videoId]: sample }));
    const nextState = browserRemoteSession.current?.recordVideoElementSample(sample);
    if (nextState) setBrowserRemoteState(nextState);
  }, []);

  function handleRemoteClipboard(text: string) {
    // 反向剪贴板同步：被控端剪贴板变化时回传文本，写入本机剪贴板（失败则保留在面板供手动处理）。
    if (!text) return;
    setClipboardText(text);
    void writeRemoteClipboardToLocal(text);
  }

  async function writeRemoteClipboardToLocal(text: string) {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setClipboardStatus(`已收到远端剪贴板（${text.length} 字符），当前环境不支持写入本机剪贴板`);
      return;
    }
    try {
      await clipboard.writeText(text);
      setClipboardStatus(`已同步远端剪贴板到本机（${text.length} 字符）`);
    } catch {
      setClipboardStatus(`已收到远端剪贴板（${text.length} 字符），写入本机被拒绝，可在剪贴板面板手动处理`);
    }
  }

  async function handleReadLocalClipboard() {
    await run("clipboard-read", async () => {
      try {
        const text = await readLocalClipboardText();
        if (typeof text !== "string") {
          setClipboardStatus("当前浏览器未返回剪贴板文本");
          return;
        }
        setClipboardText(text);
        setClipboardStatus(text.trim() ? `已读取 ${text.length} 字符` : "剪贴板为空");
      } catch (caught) {
        // 就地反馈到剪贴板面板，不打扰全局错误条；权限/非安全上下文是最常见原因。
        setClipboardStatus(
          `无法读取本机剪贴板（需在 HTTPS 或 localhost 下访问并授予剪贴板权限）：${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    });
  }

  function handleSendClipboardText() {
    if (!clipboardText.trim() || !browserRemoteSession.current) return;
    try {
      browserRemoteSession.current.sendTypedText(clipboardText);
      setClipboardStatus(`已发送 ${clipboardText.length} 字符到远端`);
      showToast("已发送剪贴板到远端");
      if (browserRemoteSession.current) setBrowserRemoteState(browserRemoteSession.current.getState());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleRemoteShortcut(shortcut: RemoteShortcut) {
    if (!inputControlActive || !browserRemoteSession.current) return;
    try {
      sendRemoteShortcut(browserRemoteSession.current, shortcut);
      setBrowserRemoteState(browserRemoteSession.current.getState());
      focusStageInput();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleToggleFullscreen() {
    // 对包含命令栏的容器请求全屏，避免全屏后命令栏（解锁输入/退出全屏等）一并消失。
    const target = remoteStageFrameRef.current ?? remoteStageRef.current;
    if (!target) return;
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen?.();
        return;
      }
      void target.requestFullscreen?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleToggleInputControl() {
    if (inputControlActive) {
      setInputControlEnabled(false);
      return;
    }
    if (controlChannelState !== "open") return;
    setInputControlEnabled(true);
    focusStageInput();
  }

  function handleInputModeChange(mode: RemoteInputMode) {
    setInputMode(mode);
    writeInputModePref(mode);
    // 切模式后把焦点重新落到正确的落点（text=隐藏输入框，native=画面本身）并立即生效。
    focusStageInput(mode);
  }

  function handleRemoteStagePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!inputControlActive || !browserRemoteSession.current) return;
    event.preventDefault();
    // 点击画面后立刻进入可打字状态；落点按当前输入方式选（物理键模式=画面本身）。
    focusStageInput();
    activePointerId.current = event.pointerId;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    try {
      // 输入热路径不主动刷新 React 状态：鼠标/键盘操作不改变任何可见 UI，
      // 而 getState() 每次返回新引用会强制整页重渲染，挤占主线程并拖慢控制心跳。
      // 通道开/关等真正的状态变化由 BrowserRemoteSession 内部在变化时单独推送。
      browserRemoteSession.current.sendMouseMove(toRemoteMousePosition(event));
      browserRemoteSession.current.sendMouseButton({ action: "mousePress", button: toRemoteMouseButton(event.button) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleRemoteStagePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!inputControlActive || !browserRemoteSession.current) return;
    if (activePointerId.current !== null && activePointerId.current !== event.pointerId) return;
    event.preventDefault();
    try {
      browserRemoteSession.current.sendMouseMove(toRemoteMousePosition(event));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleRemoteStagePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!inputControlActive || !browserRemoteSession.current) return;
    if (activePointerId.current !== null && activePointerId.current !== event.pointerId) return;
    event.preventDefault();
    activePointerId.current = null;
    if (typeof event.currentTarget.releasePointerCapture === "function" && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    try {
      browserRemoteSession.current.sendMouseMove(toRemoteMousePosition(event));
      browserRemoteSession.current.sendMouseButton({ action: "mouseRelease", button: toRemoteMouseButton(event.button) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleRemoteStagePointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (activePointerId.current !== event.pointerId) return;
    activePointerId.current = null;
    if (!inputControlActive || !browserRemoteSession.current) return;
    try {
      browserRemoteSession.current.sendMouseButton({ action: "mouseRelease", button: toRemoteMouseButton(event.button) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleRemoteStageWheel(event: WheelEvent<HTMLDivElement>) {
    if (!inputControlActive || !browserRemoteSession.current) return;
    event.preventDefault();
    try {
      browserRemoteSession.current.sendMouseScroll({ deltaX: event.deltaX, deltaY: event.deltaY });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function resolveTargetPlatform(): number | undefined {
    return roomJoinContext?.kind === "remote_assistance" ? roomJoinContext.targetPlatform : selectedDevice?.platform;
  }

  // 访客的输入：坐标归一化后按固定比例换算（协议只关心比例），
  // 字符走 text_input，其余按键走物理键——与主控本机输入同一套出口。
  function applyShareInput(event: ShareInputEvent) {
    const session = browserRemoteSession.current;
    if (!session || !inputControlActive) return;
    try {
      switch (event.kind) {
        case "move":
          session.sendMouseMove({
            absX: Math.round(event.x * 1920),
            absY: Math.round(event.y * 1080),
            surfaceWidth: 1920,
            surfaceHeight: 1080,
          });
          break;
        case "button":
          session.sendMouseButton({
            action: event.down ? "mousePress" : "mouseRelease",
            button: toRemoteMouseButton(event.button),
          });
          break;
        case "wheel":
          session.sendMouseScroll({ deltaX: event.dx, deltaY: event.dy });
          break;
        case "text":
          session.sendTypedText(event.text);
          break;
        case "key":
          session.sendKeyboardInput({ action: event.down ? "keyboardPress" : "keyboardRelease", value: event.code });
          break;
        default:
          break;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // 画面源换了（重连/切画面）就重新协商，访客不用刷新页面。
  useEffect(() => {
    share.refreshStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在画面流本身变化时重新协商
  }, [primaryRemoteStream]);

  // 键盘的落点决定输入法归谁：
  // - native：焦点放在画面本身（div，tabIndex=0，不可编辑）。浏览器只在可编辑元素上启动
  //   输入法合成，于是本机输入法根本不介入，按键原样送往被控机，中文由**被控机自己的输入法**组字。
  // - text：焦点放在 1px 隐藏输入框，本机输入法上屏后整段 text_input 发送。
  function focusStageInput(mode: RemoteInputMode = inputMode): void {
    if (mode !== "text") {
      remoteStageRef.current?.focus({ preventScroll: true });
      return;
    }
    const sink = remoteStageInputRef.current;
    if (!sink) {
      remoteStageRef.current?.focus({ preventScroll: true });
      return;
    }
    sink.focus({ preventScroll: true });
  }

  // 输入框只用来接收按键/合成，不保留任何文本：每次处理完清空，避免累积。
  function clearStageInputSink(): void {
    const sink = remoteStageInputRef.current;
    if (sink && sink.value !== "") sink.value = "";
  }

  function sendRemoteText(text: string): void {
    const session = browserRemoteSession.current;
    if (!session || !text) return;
    try {
      session.sendTypedText(text);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // 输入法上屏后，Chrome/Safari 常补发一个 Enter 或同字符的 keydown；吞掉它，
  // 否则每输入一次中文就会多一个换行。
  function isCompositionEcho(event: KeyboardEvent<HTMLElement>): boolean {
    const at = lastCompositionEndAt.current;
    if (!at || Date.now() - at > 150) return false;
    lastCompositionEndAt.current = 0;
    if (event.key === "Enter" || event.key === "Process" || event.key === "Unidentified") return true;
    return event.key.length === 1 && lastCompositionText.current.endsWith(event.key);
  }

  // 两种输入方式：
  // native（默认）——只送物理键。焦点在画面（不可编辑）上，浏览器不会给非可编辑元素启动输入法，
  //   所以本机输入法完全不介入：字母/数字/符号按物理位置原样送达被控机，由被控机的键盘布局与
  //   输入法解释。中文是在**被控机**上组字出候选的，本机输入法不参与。
  // text——可打印字符整段上屏（text_input）：大小写精确，但绕开被控端输入法，打不出中文；
  //   只作为“被控端不认物理键”时的兜底。
  function handleRemoteStageKeyDown(event: KeyboardEvent<HTMLElement>) {
    const session = browserRemoteSession.current;
    if (!inputControlActive || !session) return;

    // text 模式：输入法合成中的按键属于拼音/候选过程，等 compositionend 整段上屏。
    // native 模式没有本机合成（焦点不在可编辑元素上），不做这个判断——
    // 万一某些浏览器仍然报告合成中，keydown 里的 event.code 依旧是正确的物理键，照发即可。
    if (inputMode === "text" && event.nativeEvent.isComposing) return;
    if (isCompositionEcho(event)) {
      event.preventDefault();
      clearStageInputSink();
      return;
    }

    // Ctrl/Cmd+V：读本机剪贴板整段粘贴（画面这类非可编辑元素上 paste 事件并不可靠）。
    if ((event.ctrlKey || event.metaKey) && (event.key === "v" || event.key === "V")) {
      event.preventDefault();
      clearStageInputSink();
      void pasteClipboardToRemote();
      return;
    }

    // text 模式：可打印字符走 text_input，大小写按本机键盘原样送达（小写就是小写）。
    if (inputMode === "text" && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      clearStageInputSink();
      sendRemoteText(event.key);
      return;
    }

    // 其余按键（回车/退格/方向键/F 键/组合键）发物理键，由被控端自己解释。
    const isHoldModifier = HOLD_MODIFIER_KEYS.has(event.key);
    if (isHoldModifier && event.repeat) return; // 修饰键已按住，忽略本机自动重复
    event.preventDefault();
    clearStageInputSink();

    // 文本模式不“按住”修饰键：Shift 的字符差异已由字符本身带上，
    // 而一旦抬起时的 keyup 丢失，被控端就会一直按着 Shift —— 之后所有字母都会被转成大写。
    // 组合键（Ctrl+C 等）改成把修饰键包在按键前后各发一次，不需要真实按住状态。
    if (inputMode === "text" && isHoldModifier) return;
    const comboModifiers = inputMode === "text" ? collectComboModifierCodes(event) : [];

    const value = toRemoteKeyValue(event);
    if (value === undefined) {
      // 手机软键盘 / 特殊输入法只给字符、不给物理键（event.code 为空）：
      // 这时退回字符上屏，至少能把字打进去，而不是毫无反应。
      if (!event.ctrlKey && !event.metaKey && !event.altKey && [...event.key].length === 1 && !isHoldModifier) {
        sendRemoteText(event.key);
      }
      return;
    }
    try {
      for (const modifier of comboModifiers) {
        session.sendKeyboardInput({ action: "keyboardPress", value: modifier });
      }
      session.sendKeyboardInput({ action: "keyboardPress", value });
      if (!isHoldModifier) {
        session.sendKeyboardInput({ action: "keyboardRelease", value });
      }
      for (const modifier of [...comboModifiers].reverse()) {
        session.sendKeyboardInput({ action: "keyboardRelease", value: modifier });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // 文本模式下组合键需要的修饰键（Android KEYCODE_CTRL_LEFT / ALT_LEFT / META_LEFT）。
  function collectComboModifierCodes(event: KeyboardEvent<HTMLElement>): number[] {
    const codes: number[] = [];
    if (event.ctrlKey) codes.push(113);
    if (event.altKey) codes.push(57);
    if (event.metaKey) codes.push(117);
    return codes;
  }

  // 输入法上屏（中文/日文等）：整段作为一帧 text_input 送达，被控端直接插入这段字符。
  function handleRemoteStageCompositionEnd(event: CompositionEvent<HTMLInputElement>) {
    const data = event.data ?? "";
    lastCompositionEndAt.current = Date.now();
    lastCompositionText.current = data;
    clearStageInputSink();
    // 物理键模式下拼音是在被控机上合成的，本机若也有输入法，上屏文本不能重复发送。
    if (inputMode !== "text" || !inputControlActive || !data) return;
    sendRemoteText(data);
  }

  // 输入框只承载按键事件，不承载文本：任何插入都立刻丢弃，避免字符在框里堆积。
  function handleRemoteStageInput() {
    clearStageInputSink();
  }

  // 读取本机剪贴板并整段粘贴到远端。剪贴板 API 需要安全上下文 + 用户手势（按键即手势）。
  async function pasteClipboardToRemote(): Promise<void> {
    const session = browserRemoteSession.current;
    if (!inputControlActive || !session) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setClipboardStatus("本机剪贴板为空，没有可粘贴的内容");
        return;
      }
      session.sendTypedText(text);
      setClipboardText(text);
      setClipboardStatus(`已粘贴 ${text.length} 字符到远端`);
    } catch (caught) {
      // 浏览器拒绝时给出可执行的替代方案，而不是静默失败。
      setClipboardStatus(
        `无法读取本机剪贴板（${caught instanceof Error ? caught.message : String(caught)}），请用下方「剪贴板」面板的「读取剪贴板」再发送`,
      );
    }
  }

  function handleRemoteStageKeyUp(event: KeyboardEvent<HTMLElement>) {
    if (!inputControlActive || !browserRemoteSession.current) return;
    // 文本模式下没有按住过修饰键（组合键是一次性包发），所以也不需要释放。
    if (inputMode === "text") return;
    // 只有修饰键是“按住”的，需在抬起时释放;普通键已在 keydown 即时抬起。
    if (!HOLD_MODIFIER_KEYS.has(event.key)) return;
    event.preventDefault();
    const value = toRemoteKeyValue(event);
    if (value === undefined) return;
    try {
      browserRemoteSession.current.sendKeyboardInput({ action: "keyboardRelease", value });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleRemoteStageBlur() {
    // 失焦时把按住的键鼠全部抬起：Alt+Tab、右键菜单、系统快捷键会吞掉 keyup/pointerup，
    // 否则会在被控端留下卡住的按键（右键卡死、Alt 卡死等）。
    activePointerId.current = null;
    browserRemoteSession.current?.releaseAllInputs();
  }

  function handleRemoteStagePaste(event: ClipboardEvent<HTMLElement>) {
    // 右键菜单/系统菜单触发的粘贴走这里；键盘 Ctrl+V 已在 keydown 里处理并 preventDefault。
    if (!inputControlActive || !browserRemoteSession.current) return;
    const text = event.clipboardData?.getData("text") ?? "";
    if (!text) return;
    event.preventDefault();
    clearStageInputSink();
    sendRemoteText(text);
  }

  const loggedIn = Boolean(authStatus?.hasState);
  const deviceTotal = devices.desktopDevices.length + devices.mobileDevices.length + devices.tvDevices.length;
  const canSubmitMobile = mobile.trim().length > 0 && busy === null && smsCountdown === 0;
  const canLogin = mobile.trim().length > 0 && smsCode.trim().length > 0 && busy === null;

  useAutoLoadDevices({
    loggedIn,
    devicesLoaded,
    busy,
    loadDevices: () => void loadDevices(),
  });

  const identitySourceLabel = authStatus?.deviceId ? "网页控制端" : "待创建设备";
  const identityDeviceLabel = authStatus?.deviceId ?? "-";
  const roomDebugPayload = roomResponse
    ? {
        upstream: summarizeRoomJoinUpstream(roomResponse.upstream),
        roomConfigSummary: roomResponse.roomConfigSummary,
        sessionReference: roomResponse.sessionReference,
        remoteBootstrap,
        signalGatewayStatus,
        remoteSignalDiagnostics,
        roomJoinContext,
        signalGatewayContext,
      }
    : null;
  const signalGatewayState = signalGatewayStatus?.status ?? "idle";
  const activeSignalHeaders = signalGatewayStatus?.signalHeaders ?? remoteBootstrap?.signalHeaders;
  const signalHeaderSummary = activeSignalHeaders ? Object.entries(activeSignalHeaders).map(([key, value]) => `${key}=${value}`).join(", ") : "-";
  const roomJoinFailureMessage = getRoomJoinFailureMessage(roomResponse);
  const roomJoinFailureTakeoverHint = getRoomJoinFailureTakeoverHint(roomResponse, forceJoin);
  const selectedDeviceIsCurrentAuthDevice = Boolean(authStatus?.deviceId && selectedDeviceId && selectedDeviceId === authStatus.deviceId);
  const selfDeviceBlockedReason = selectedDeviceIsCurrentAuthDevice ? SELF_DEVICE_BLOCKED_REASON : "";
  const roomJoinedForSelectedDevice = roomJoinContext?.deviceId === selectedDeviceId && Boolean(roomResponse?.roomConfigSummary);
  const roomRequiresTakeover = roomJoinedForSelectedDevice && roomJoinContext?.occupiedAtJoin === true && !roomJoinContext.forceJoin;
  const signalGatewayMatchesRoom =
    signalGatewayState === "connected" &&
    signalGatewayContext?.deviceId === roomJoinContext?.deviceId &&
    signalGatewayContext?.forceJoin === roomJoinContext?.forceJoin &&
    (signalGatewayContext?.kind ?? "owned_device") === (roomJoinContext?.kind ?? "owned_device");
  const roomReadyForBrowserRtc = roomJoinedForSelectedDevice && !roomRequiresTakeover && signalGatewayMatchesRoom;
  const browserRtcBlockedReason = selfDeviceBlockedReason
    ? selfDeviceBlockedReason
    : roomJoinFailureMessage
      ? roomJoinFailureMessage
      : !roomJoinedForSelectedDevice
        ? "请先加入房间"
        : roomRequiresTakeover
          ? "选择接管后重试"
          : !signalGatewayMatchesRoom
            ? "重新连接"
            : "";
  const normalJoinLeftBeforeAnswer =
    roomJoinContext?.forceJoin === false &&
    signalReadiness.blocker === "controlled_left_before_answer" &&
    signalReadiness.checks.offerSent &&
    !signalReadiness.checks.answerReceived;
  const normalJoinTakeoverHint = normalJoinLeftBeforeAnswer ? "画面未返回。" : "";
  const browserRtcReady = roomReadyForBrowserRtc && busy === null;
  const browserIceServers = browserRemoteState.controlResult?.iceServers.length ?? 0;
  const connectionPathLabel = formatConnectionPath(browserRemoteState.connectionPath);
  const inboundVideoStatsLabel = formatInboundVideoStats(browserRemoteState.inboundVideo);
  const videoFlowLabel = formatVideoFlow(browserRemoteState);
  const videoElementLabel = formatVideoElement(browserRemoteState.videoElement);
  const textChannelState = browserRemoteState.dataChannels[STREAMER_DATA_CHANNEL_LABELS.text] ?? "closed";
  const controlChannelState = browserRemoteState.dataChannels[STREAMER_DATA_CHANNEL_LABELS.control] ?? "closed";
  const controlChannelLabel = formatDataChannelState(controlChannelState);
  const textChannelLabel = formatDataChannelState(textChannelState);
  const inputControlActive = inputControlEnabled && controlChannelState === "open";
  const inputControlLabel = inputControlActive
    ? "控制中"
    : controlChannelState === "open"
      ? "仅查看"
      : controlChannelLabel;
  const decodeStalledPersisted =
    browserRemoteState.videoFlow?.status === "decode_stalled" && decodeStalledStreak >= 2;
  const browserConnectionRecoverable =
    browserRemoteState.stage === "connected" &&
    (controlChannelState === "closed" ||
      browserRemoteState.videoFlow?.status === "transport_stalled" ||
      decodeStalledPersisted);
  const remoteRecoveryLabel = browserConnectionRecoverable
    ? controlChannelState === "closed"
      ? "控制连接已断开"
      : decodeStalledPersisted
        ? "画面卡顿（解码异常）"
        : "画面中断（网络）"
    : "";
  const autoReconnectLabel = browserConnectionRecoverable && autoReconnectEnabled
    ? autoReconnectStatus || "自动重连准备中"
    : autoReconnectEnabled
      ? "自动重连已开启"
      : "自动重连已关闭";
  const canReadLocalClipboard = busy === null;
  const canSendClipboardText = inputControlActive && textChannelState === "open" && clipboardText.trim().length > 0;
  const clipboardPreviewLabel = clipboardText.trim() ? `${clipboardText.length} 字符待发送` : "剪贴板内容未读取";
  const connectionQuality = getRemoteConnectionQuality({
    state: browserRemoteState,
    controlChannelState,
    inputControlActive,
    textChannelState,
    connectionPathLabel,
  });

  useEffect(() => {
    // 累计连续“解码停滞”采样数：要求持续 ≥2 次才触发自动恢复，避免偶发解码抖动误重连。
    setDecodeStalledStreak((streak) =>
      browserRemoteState.videoFlow?.status === "decode_stalled" ? streak + 1 : 0,
    );
  }, [browserRemoteState.videoFlow]);

  useEffect(() => {
    if (!browserConnectionRecoverable) {
      if (autoReconnectAttemptCount !== 0) setAutoReconnectAttemptCount(0);
      if (autoReconnectStatus) setAutoReconnectStatus("");
      return;
    }
    if (!autoReconnectEnabled || busy !== null || !roomJoinedForSelectedDevice || !signalGatewayMatchesRoom) return;

    const delayMs = Math.min(5000, 900 * 2 ** Math.min(autoReconnectAttemptCount, 3));
    setAutoReconnectStatus(`自动重连将在 ${Math.ceil(delayMs / 1000)} 秒后尝试`);
    const timer = window.setTimeout(() => {
      setAutoReconnectAttemptCount((count) => count + 1);
      void handleReconnectRemote();
    }, delayMs);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleReconnectRemote 每次渲染重建，纳入依赖会导致退避定时器被反复重置
  }, [
    autoReconnectAttemptCount,
    autoReconnectEnabled,
    autoReconnectStatus,
    browserConnectionRecoverable,
    busy,
    roomJoinedForSelectedDevice,
    signalGatewayMatchesRoom,
  ]);
  const selectedCandidatePair = browserRemoteState.selectedCandidatePair;
  const candidatePairSummary = selectedCandidatePair
    ? `${selectedCandidatePair.localCandidateType ?? "-"} -> ${selectedCandidatePair.remoteCandidateType ?? "-"}`
    : "-";
  const networkSwitchSummary = summarizeSwitchNetworkNotify(signalEvents);
  const unexpectedSignalEventSummary = summarizeUnexpectedSignalEvents(signalEvents, remoteBootstrap?.signalEvents ?? []);
  const signalServerOptions = remoteBootstrap?.signalServers ?? [];
  const signalGatewayErrorHint = formatSignalGatewayErrorHint(signalGatewayStatus);
  const autoSwitchThresholdLabel = formatAutoSwitchThresholds(browserRemoteState.controlResult);
  const sdpTransportLabel = sdpTransportMode === "gzip" ? "gzip_sdp" : "plain_sdp";
  const connectionRouteLabel = connectionRouteMode === "relay" ? "强制中转" : "自动路径";
  const effectiveConnectionRouteLabel =
    connectionRouteMode === "relay"
      ? "强制中转"
      : browserRemoteState.controlResult?.forceRelay
        ? "服务端要求中转"
        : connectionRouteLabel;
  const serviceRoutePolicyLabel = browserRemoteState.controlResult?.forceRelay
    ? "服务端要求中转"
    : browserRemoteState.controlResult?.autoSwitchNetwork
      ? "服务端自动切换"
      : "-";
  const iceControlStatusLabel =
    browserRemoteState.controlResultIceId
      ? browserRemoteState.controlIceIdMatch === undefined
        ? "使用 ack ICE"
        : browserRemoteState.controlIceIdMatch
          ? "ack ICE 已对齐"
          : "ack ICE 覆盖本地候选"
      : browserRemoteState.iceId
        ? "ICE 等待 ack"
        : "-";
  const signalGatewayDisplay = formatSignalGatewayState(signalGatewayState);
  const browserStageLabel = formatBrowserRemoteStage(browserRemoteState.stage);
  const browserRtcDescription = browserRemoteState.controlResult ? "连接许可已确认" : "等待连接确认";
  const joinModeLabel = forceJoin ? "接管控制" : "普通加入";
  const roomJoinModeDebugLabel = formatRoomJoinContext(remoteBootstrap?.joinContext);
  const selectedTargetLabel = roomJoinContext?.kind === "remote_assistance"
    ? roomJoinContext.deviceName ?? `远程协助 ${roomJoinContext.connectId ?? roomJoinContext.deviceId}`
    : selectedDevice?.alias ?? "远控画面";
  const remoteVideoCount = remoteVideoStreams.length;
  const debugEvents = browserRemoteState.debugEvents;
  const hasRemoteVideo = remoteVideoCount > 0;
  const canDisconnectRemote =
    signalGatewayState === "connected" ||
    browserRemoteState.stage !== "idle" ||
    remoteVideoCount > 0 ||
    controlChannelState !== "closed" ||
    textChannelState !== "closed";
  const roomReleaseLabel = formatRoomReleaseState(signalGatewayStatus, canDisconnectRemote, selectedDeviceOccupied, roomJoinContext);
  const roomReleaseDetail = formatRoomReleaseDetail(signalGatewayStatus, roomJoinContext);
  const nextAction = getNextAction({
    busy,
    browserConnectionRecoverable,
    controlChannelState,
    deviceTotal,
    inputControlActive,
    loggedIn,
    roomJoinedForSelectedDevice,
    remoteAssistanceTarget: roomJoinContext?.kind === "remote_assistance",
    roomRequiresTakeover,
    selectedDeviceId,
    selectedDeviceIsCurrentAuthDevice,
    signalGatewayErrored: signalGatewayState === "error",
    signalGatewayMatchesRoom,
    browserStage: browserRemoteState.stage,
    forceJoin,
  });

  useEffect(() => {
    if (controlChannelState !== "open" && inputControlEnabled) {
      setInputControlEnabled(false);
    }
  }, [controlChannelState, inputControlEnabled]);

  useEffect(() => {
    if (controlChannelState !== "open") {
      controlChannelOpenedRef.current = false;
      return;
    }
    if (controlChannelOpenedRef.current) return;
    // 连接成功（控制通道打开）后默认进入操作状态：自动启用输入控制并聚焦画面，无需再手动点一下。
    controlChannelOpenedRef.current = true;
    setInputControlEnabled(true);
    focusStageInput();
  }, [controlChannelState]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem("uurc.autoConnect", autoConnect ? "true" : "false");
    } catch {
      // 忽略持久化失败（隐私模式等）。
    }
  }, [autoConnect]);

  const remoteAssistanceActive = roomJoinContext?.kind === "remote_assistance";
  useEffect(() => {
    if (!controlRouteMatch) {
      autoConnectAttemptedDeviceRef.current = "";
      return;
    }
    if (
      !autoConnect ||
      !loggedIn ||
      !selectedDeviceId ||
      selectedDeviceIsCurrentAuthDevice ||
      occupiedByOthers ||
      busy !== null ||
      browserRemoteState.stage !== "idle" ||
      signalGatewayState === "connected" ||
      autoConnectAttemptedDeviceRef.current === selectedDeviceId ||
      // 自有设备需等设备列表加载完、且确实能定位到该设备，才知道占用情况并决定是否接管；
      // 远程协助的目标不在设备列表内，走各自的加入流程，不受此限制。
      (!remoteAssistanceActive && (!devicesLoaded || !selectedDevice))
    ) {
      return;
    }
    // 进入设备控制页后自动发起一次连接：他人占用已被 occupiedByOthers 排除；
    // 若仅被自己上一个会话占用，handleNextAction 会自动接管（force join）。
    autoConnectAttemptedDeviceRef.current = selectedDeviceId;
    void handleNextAction();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleNextAction 每次渲染重建，不入依赖；用 ref 保证每台设备只自动连一次
  }, [
    controlRouteMatch,
    autoConnect,
    loggedIn,
    selectedDeviceId,
    selectedDeviceIsCurrentAuthDevice,
    occupiedByOthers,
    devicesLoaded,
    selectedDevice,
    remoteAssistanceActive,
    busy,
    browserRemoteState.stage,
    signalGatewayState,
  ]);

  useEffect(() => {
    const releaseHeldInputs = () => browserRemoteSession.current?.releaseAllInputs();
    const onVisibilityChange = () => {
      if (document.hidden) releaseHeldInputs();
    };
    // 切换到其它应用/标签页（Alt+Tab、Win+D 等系统快捷键会抢走焦点）时，抬起所有按住的键鼠。
    window.addEventListener("blur", releaseHeldInputs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", releaseHeldInputs);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const stage = remoteStageRef.current;
    if (!stage || !inputControlActive) return;
    // React 的 onWheel 是被动监听，event.preventDefault() 无效，会导致整页跟随滚动；
    // 用原生非被动监听把滚动锁在画面内（仅在已解锁输入时）。
    // 注意：顶部从 react 导入了 WheelEvent 类型，会遮蔽 DOM 的同名类型；这里用 Event 即可。
    const lockPageScroll = (event: Event) => event.preventDefault();
    stage.addEventListener("wheel", lockPageScroll, { passive: false });
    return () => stage.removeEventListener("wheel", lockPageScroll);
  }, [inputControlActive]);

  // 画面源信息：为每一路视频附上分辨率与是否有信号；hidden tile 的 videoWidth 依然是真实值，
  // 因此即使某路当前未显示，也能据此标注“无信号”。未采样到（刚连上）时按有信号处理，避免误报。
  const remoteVideoSources: RemoteVideoSourceInfo[] = remoteVideoStreams.map((video, index) => {
    const sample = remoteVideoSamplesById[video.id];
    const active = Boolean(sample) && (sample?.width ?? 0) > 0 && (sample?.height ?? 0) > 0;
    return {
      id: video.id,
      index,
      resolution: active ? `${sample?.width}×${sample?.height}` : "",
      hasSignal: !sample || active,
    };
  });
  const primaryRemoteVideoSample = remoteVideoSamplesById[primaryRemoteVideoId];
  const primaryRemoteVideoActive =
    !primaryRemoteVideoSample || ((primaryRemoteVideoSample.width ?? 0) > 0 && (primaryRemoteVideoSample.height ?? 0) > 0);
  const remoteShortcutPlatform = remoteShortcutGroupTitleForPlatform(resolveTargetPlatform());
  const deviceNotFound = loggedIn && devicesLoaded && Boolean(selectedDeviceId) && !selectedDevice && !remoteAssistanceActive;
  // 画面区中央的状态文案：与顶栏状态对齐，避免出现“未连接/已就绪/等待连接”多套说法互相矛盾。
  const stageStatusLabel =
    browserRemoteState.stage === "connected"
      ? "已连接"
      : browserRemoteState.remoteTrackCount > 0
        ? "正在加载画面…"
        : signalGatewayState === "connected" || busy === "signal-start" || busy === "browser-remote-start"
          ? "连接中…"
          : occupiedByOthers && !forceJoin
            ? "设备被占用，点「接管并开始连接」"
            : roomResponse || remoteBootstrap
              ? "已就绪，点「开始连接」"
              : "未连接";

  const loginPageProps = {
    authJson,
    regionCode,
    mobile,
    smsCode,
    loginNotice,
    codeSent,
    smsCountdown,
    error,
    busy,
    canSubmitMobile,
    canLogin,
    onAuthJsonChange: setAuthJson,
    onRegionCodeChange: setRegionCode,
    onMobileChange: setMobile,
    onSmsCodeChange: setSmsCode,
    onSendMobileCode: () => void handleSendMobileCode(),
    onMobileLogin: () => void handleMobileLogin(),
    onImport: () => void handleImport(),
  };

  const deviceListPageProps = {
    authStatus,
    authJson,
    devices,
    devicesLoaded,
    selectedDeviceId,
    assistanceConnectId,
    assistanceConnectCode,
    assistanceNotice,
    assistanceTargetPlatform,
    identitySourceLabel,
    identityDeviceLabel,
    error,
    busy,
    onLoadStatus: () => void loadStatus(),
    onLoadDevices: () => void loadDevices(),
    onSelectDevice: setSelectedDeviceId,
    onOpenDevice: (deviceId: string) => void handleOpenDevice(deviceId),
    onAssistanceConnectIdChange: setAssistanceConnectId,
    onAssistanceConnectCodeChange: setAssistanceConnectCode,
    onAssistanceTargetPlatformChange: setAssistanceTargetPlatform,
    onStartRemoteAssistance: () => void handleStartRemoteAssistance(),
    onExport: () => void handleExport(),
    onCopyAuthJson: () => void handleCopyAuthJson(),
    onLogout: () => void handleLogout(),
  };

  const controlPageProps: RemoteControlPageProps = {
    autoSwitchThresholdLabel,
    autoConnect,
    autoReconnectEnabled,
    autoReconnectLabel,
    browserIceServers,
    browserRemoteState,
    browserRtcDescription,
    browserRtcReady,
    browserStageLabel,
    busy,
    canDisconnectRemote,
    canReadLocalClipboard,
    canReconnectRemote: browserConnectionRecoverable,
    canSendClipboardText,
    candidatePairSummary,
    clipboardPreviewLabel,
    clipboardStatusLabel: clipboardStatus,
    connectionQuality,
    connectionPathLabel,
    connectionRouteMode,
    controlChannelLabel,
    controlChannelState,
    debugEvents,
    deviceNotFound,
    effectiveConnectionRouteLabel,
    error,
    forceJoin,
    hasRemoteVideo,
    iceControlStatusLabel,
    inboundVideoStatsLabel,
    inputControlActive,
    inputControlLabel,
    joinModeLabel,
    networkSwitchSummary,
    nextAction,
    normalJoinTakeoverHint,
    occupiedBySelfClient,
    occupyingParticipantLabel,
    primaryRemoteVideoActive,
    primaryRemoteVideoId,
    remoteBootstrap,
    remoteRecoveryLabel,
    remoteShortcutPlatform,
    share,
    remoteStageRef,
    remoteStageInputRef,
    remoteStageFrameRef,
    isFullscreen,
    remoteStageViewMode,
    remoteVideoCount,
    remoteVideoSources,
    remoteVideoStreams,
    stageStatusLabel,
    roomDebugPayload,
    roomJoinFailureMessage,
    roomJoinFailureTakeoverHint,
    roomJoinModeDebugLabel,
    roomReleaseDetail,
    roomReleaseLabel,
    roomResponseReady: Boolean(roomResponse),
    runtimeProfile,
    roomRequiresTakeover,
    sdpTransportLabel,
    sdpTransportMode,
    selectedDevice,
    selectedDeviceId,
    selectedTargetLabel,
    selectedDeviceOccupied,
    selectedParticipants,
    selfDeviceBlockedReason,
    serviceRoutePolicyLabel,
    signalEvents,
    signalGatewayDisplay,
    signalGatewayErrorHint,
    signalHeaderSummary,
    signalReadiness,
    signalServerIndex,
    signalServerOptions,
    textChannelLabel,
    textChannelState,
    unexpectedSignalEventSummary,
    videoElementLabel,
    videoFlowLabel,
    onAutoReconnectEnabledChange: setAutoReconnectEnabled,
    onAutoConnectChange: setAutoConnect,
    onConnectionRouteModeChange: setConnectionRouteMode,
    onForceJoinChange: setForceJoin,
    onNextAction: () => void handleNextAction(),
    onReconnectRemote: () => void handleReconnectRemote(),
    onRemoteStageKeyDown: handleRemoteStageKeyDown,
    onRemoteStageKeyUp: handleRemoteStageKeyUp,
    onRemoteStageBlur: handleRemoteStageBlur,
    onRemoteStagePaste: handleRemoteStagePaste,
    onRemoteStageCompositionEnd: handleRemoteStageCompositionEnd,
    onRemoteStageInput: handleRemoteStageInput,
    inputMode,
    onInputModeChange: handleInputModeChange,
    onRemoteStagePointerCancel: handleRemoteStagePointerCancel,
    onRemoteStagePointerDown: handleRemoteStagePointerDown,
    onRemoteStagePointerMove: handleRemoteStagePointerMove,
    onRemoteStagePointerUp: handleRemoteStagePointerUp,
    onRemoteStageWheel: handleRemoteStageWheel,
    onRemoteShortcut: handleRemoteShortcut,
    onRemoteVideoSourceChange: setSelectedRemoteVideoId,
    onRemoteVideoSample: handleRemoteVideoSample,
    onReadLocalClipboard: () => void handleReadLocalClipboard(),
    onReturnToDevices: () => void handleReturnToDevices(),
    onSdpTransportModeChange: setSdpTransportMode,
    onSignalServerIndexChange: setSignalServerIndex,
    onStartBrowserRemote: () => void handleStartBrowserRemote(),
    onStartSignalGateway: () => void handleStartSignalGateway(),
    onStageViewModeChange: setRemoteStageViewMode,
    onStopSignalGateway: () => void handleStopSignalGateway(),
    onSendClipboardText: handleSendClipboardText,
    onToggleInputControl: handleToggleInputControl,
    onToggleFullscreen: handleToggleFullscreen,
  };

  return {
    authLoading: authStatus === null && busy === "status",
    loggedIn,
    toast,
    onDismissToast: () => setToast(null),
    loginPageProps,
    deviceListPageProps,
    controlPageProps,
  };
}
