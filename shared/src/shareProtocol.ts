// 分享链接（临时观看/操作）的线路协议。
//
// 拓扑：访客浏览器 ←WebRTC→ 主控浏览器 → UU 远控会话 → 被控电脑。
// 访客不接触 UU 的任何凭证，所有输入都由主控浏览器转发进已有的控制通道，
// 因此不需要改动逆向协议，也不会把 room token 交给第三方。
//
// 信令走 Durable Object（同一个分享 ID 一个实例）：主控与访客各开一条 WebSocket，
// DO 只做转发和鉴权，不落盘任何媒体。

export const SHARE_WS_PATH_PREFIX = "/api/share/";
export const SHARE_MAX_GUESTS = 4;
export const SHARE_MAX_PASSWORD_LENGTH = 64;
export const SHARE_MIN_PASSWORD_LENGTH = 4;

export type ShareRole = "host" | "guest";

/** 访客的输入事件：归一化坐标 + 字符/键码，由主控浏览器翻译成远控报文。 */
export type ShareInputEvent =
  | { kind: "move"; x: number; y: number }
  | { kind: "button"; button: number; down: boolean }
  | { kind: "wheel"; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; code: number; down: boolean };

export type ShareServerMessage =
  | { type: "ready"; role: ShareRole; guestId: string; controlEnabled: boolean }
  | { type: "auth-error"; message: string }
  | { type: "signal"; from: string; payload: ShareSignalPayload }
  | { type: "guest-joined"; guestId: string }
  | { type: "guest-left"; guestId: string }
  | { type: "input"; from: string; event: ShareInputEvent }
  | { type: "control"; enabled: boolean }
  | { type: "error"; message: string };

export type ShareClientMessage =
  | { type: "auth"; role: ShareRole; password?: string; hostToken?: string }
  | { type: "signal"; to: string; payload: ShareSignalPayload }
  | { type: "input"; event: ShareInputEvent }
  | { type: "control"; enabled: boolean };

export type ShareSignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export function parseShareClientMessage(raw: string): ShareClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "auth": {
      const role = value.role === "host" || value.role === "guest" ? value.role : null;
      if (!role) return null;
      const password = typeof value.password === "string" ? value.password : undefined;
      const hostToken = typeof value.hostToken === "string" ? value.hostToken : undefined;
      return { type: "auth", role, password, hostToken };
    }
    case "signal": {
      const payload = parseShareSignalPayload(value.payload);
      if (!payload || typeof value.to !== "string" || value.to.length === 0) return null;
      return { type: "signal", to: value.to.slice(0, 64), payload };
    }
    case "input": {
      const event = parseShareInputEvent(value.event);
      if (!event) return null;
      return { type: "input", event };
    }
    case "control": {
      if (typeof value.enabled !== "boolean") return null;
      return { type: "control", enabled: value.enabled };
    }
    default:
      return null;
  }
}

export function parseShareSignalPayload(value: unknown): ShareSignalPayload | null {
  if (!isRecord(value)) return null;
  if (value.kind === "offer" || value.kind === "answer") {
    if (typeof value.sdp !== "string" || value.sdp.length === 0 || value.sdp.length > 200_000) return null;
    return { kind: value.kind, sdp: value.sdp };
  }
  if (value.kind === "ice") {
    const candidate = value.candidate;
    if (!isRecord(candidate) || typeof candidate.candidate !== "string") return null;
    return { kind: "ice", candidate: candidate as RTCIceCandidateInit };
  }
  return null;
}

export function parseShareInputEvent(value: unknown): ShareInputEvent | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "move": {
      const x = clampUnit(value.x);
      const y = clampUnit(value.y);
      if (x === null || y === null) return null;
      return { kind: "move", x, y };
    }
    case "button": {
      const button = typeof value.button === "number" ? Math.trunc(value.button) : NaN;
      if (!Number.isFinite(button) || button < 0 || button > 4) return null;
      if (typeof value.down !== "boolean") return null;
      return { kind: "button", button, down: value.down };
    }
    case "wheel": {
      const dx = finiteNumber(value.dx);
      const dy = finiteNumber(value.dy);
      if (dx === null || dy === null) return null;
      return { kind: "wheel", dx, dy };
    }
    case "text": {
      if (typeof value.text !== "string" || value.text.length === 0) return null;
      if (value.text.length > 4096) return null;
      return { kind: "text", text: value.text };
    }
    case "key": {
      const code = typeof value.code === "number" ? Math.trunc(value.code) : NaN;
      if (!Number.isFinite(code) || code <= 0 || code > 512) return null;
      if (typeof value.down !== "boolean") return null;
      return { kind: "key", code, down: value.down };
    }
    default:
      return null;
  }
}

function clampUnit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(-4096, Math.min(4096, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
