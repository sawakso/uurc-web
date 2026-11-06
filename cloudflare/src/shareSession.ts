import {
  SHARE_MAX_GUESTS,
  parseShareClientMessage,
  type ShareInputEvent,
  type ShareServerMessage,
  type ShareSignalPayload,
} from "@uurc/shared/shareProtocol";

// 分享会话：一个分享 ID 一个 DO 实例。只做三件事——
// 1) 校验口令（只存加盐哈希，不存明文）；
// 2) 在主控与访客之间转发 WebRTC 信令；
// 3) 把访客的输入事件转给主控浏览器（真正的远控报文由主控产生）。
// 不落盘任何 SDP/媒体/输入内容。

interface ShareSocketState {
  role: "host" | "guest";
  guestId: string;
}

const AUTH_TIMEOUT_MS = 10_000;
const MAX_FAILED_ATTEMPTS = 20;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export class ShareSession implements DurableObject {
  private readonly ctx: DurableObjectState;
  private host: WebSocket | null = null;
  private readonly guests = new Map<string, WebSocket>();
  private failedAttempts = 0;
  private failedSince = 0;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const action = request.headers.get("x-uurc-share-action");
    if (action === "configure") {
      return this.handleConfigure(request);
    }
    if (action === "info") {
      const passwordHash = await this.ctx.storage.get<string>("passwordHash");
      return json({ exists: Boolean(passwordHash), guests: this.guests.size });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected websocket" }, 426);
    }
    return this.handleSocket(request);
  }

  private async handleConfigure(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { passwordHash?: unknown } | null;
    const passwordHash = typeof body?.passwordHash === "string" ? body.passwordHash : "";
    if (!/^[0-9a-f]{64}$/.test(passwordHash)) {
      return json({ error: "invalid password hash" }, 400);
    }
    await this.ctx.storage.put("passwordHash", passwordHash);
    await this.ctx.storage.put("createdAt", Date.now());
    // 已有会话全部断掉：改口令等于让旧链接立即失效。
    this.host?.close(4000, "reconfigured");
    for (const guest of this.guests.values()) guest.close(4000, "reconfigured");
    this.host = null;
    this.guests.clear();
    return json({ ok: true });
  }

  private handleSocket(request: Request): Response {
    const isHost = request.headers.get("x-uurc-share-role") === "host";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let state: ShareSocketState | null = null;
    const authTimer = setTimeout(() => {
      send(server, { type: "auth-error", message: "认证超时" });
      server.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    server.addEventListener("message", (event) => {
      void this.handleMessage(server, state, event.data, isHost).then((next) => {
        if (next) {
          state = next;
          clearTimeout(authTimer);
        }
      });
    });

    const drop = () => {
      clearTimeout(authTimer);
      this.forget(server, state);
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(
    socket: WebSocket,
    state: ShareSocketState | null,
    raw: unknown,
    isHostConnection: boolean,
  ): Promise<ShareSocketState | null> {
    if (typeof raw !== "string") return null;
    const message = parseShareClientMessage(raw);
    if (!message) {
      send(socket, { type: "error", message: "消息格式不正确" });
      return null;
    }

    if (!state) {
      if (message.type !== "auth") return null;
      return this.authenticate(socket, message.role, message.password, isHostConnection);
    }

    if (message.type === "auth") return null;

    if (state.role === "host") {
      if (message.type === "signal") {
        const target = this.guests.get(message.to);
        if (target) {
          send(target, { type: "signal", from: state.guestId, payload: message.payload } satisfies ShareServerMessage);
        }
        return null;
      }
      if (message.type === "control") {
        for (const guest of this.guests.values()) {
          send(guest, { type: "control", enabled: message.enabled });
        }
      }
      return null;
    }

    // 访客 -> 主控
    if (message.type === "signal") {
      if (this.host) {
        send(this.host, { type: "signal", from: state.guestId, payload: message.payload } satisfies ShareServerMessage);
      }
      return null;
    }
    if (message.type === "input") {
      if (this.host) {
        send(this.host, { type: "input", from: state.guestId, event: message.event });
      }
    }
    return null;
  }

  private async authenticate(
    socket: WebSocket,
    role: "host" | "guest",
    password: string | undefined,
    isHostConnection: boolean,
  ): Promise<ShareSocketState | null> {
    if (role === "host" && !isHostConnection) {
      send(socket, { type: "auth-error", message: "只有站点所有者可以发起分享" });
      socket.close(4003, "forbidden");
      return null;
    }

    const passwordHash = await this.ctx.storage.get<string>("passwordHash");
    if (!passwordHash) {
      send(socket, { type: "auth-error", message: "分享已失效" });
      socket.close(4004, "no share");
      return null;
    }

    if (role === "guest") {
      if (this.tooManyFailures()) {
        send(socket, { type: "auth-error", message: "口令错误次数过多，请稍后再试" });
        socket.close(4029, "too many attempts");
        return null;
      }
      if (!password || (await hashPassword(password)) !== passwordHash) {
        this.recordFailure();
        send(socket, { type: "auth-error", message: "口令不正确" });
        socket.close(4003, "bad password");
        return null;
      }
      if (this.guests.size >= SHARE_MAX_GUESTS) {
        send(socket, { type: "auth-error", message: "观看人数已满，请稍后再试" });
        socket.close(4009, "full");
        return null;
      }
    }

    if (role === "host") {
      this.host?.close(4000, "replaced");
      this.host = socket;
      send(socket, { type: "ready", role, guestId: "host", controlEnabled: true });
      // 主控晚到：把它已经错过的访客补一遍，让主控立即发起 offer。
      for (const guestId of this.guests.keys()) {
        send(socket, { type: "guest-joined", guestId });
      }
      return { role, guestId: "host" };
    }

    const guestId = `g-${crypto.randomUUID().slice(0, 8)}`;
    this.guests.set(guestId, socket);
    send(socket, { type: "ready", role, guestId, controlEnabled: Boolean(this.host) });
    if (this.host) send(this.host, { type: "guest-joined", guestId });
    return { role, guestId };
  }

  private forget(socket: WebSocket, state: ShareSocketState | null): void {
    if (!state) return;
    if (state.role === "host") {
      if (this.host === socket) this.host = null;
      for (const guest of this.guests.values()) {
        send(guest, { type: "control", enabled: false });
      }
      return;
    }
    if (this.guests.get(state.guestId) === socket) {
      this.guests.delete(state.guestId);
      if (this.host) send(this.host, { type: "guest-left", guestId: state.guestId });
    }
  }

  private tooManyFailures(): boolean {
    if (Date.now() - this.failedSince > FAILURE_WINDOW_MS) {
      this.failedAttempts = 0;
      this.failedSince = 0;
    }
    return this.failedAttempts >= MAX_FAILED_ATTEMPTS;
  }

  private recordFailure(): void {
    if (this.failedAttempts === 0) this.failedSince = Date.now();
    this.failedAttempts += 1;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function send(socket: WebSocket, message: ShareServerMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // 对端已断开：忽略，close/error 回调会做清理。
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export type { ShareInputEvent, ShareSignalPayload };
