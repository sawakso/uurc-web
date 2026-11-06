import type { ShareInputEvent, ShareServerMessage, ShareSignalPayload } from "@uurc/shared/shareProtocol";

export type ShareGuestStatus = "connecting" | "waiting-host" | "connected" | "closed" | "error";

export interface ShareGuestSessionOptions {
  onStatus: (status: ShareGuestStatus, message: string) => void;
  onStream: (stream: MediaStream | null) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * 访客侧：口令认证 + 接收主控转发过来的画面 + 把本地输入回传给主控。
 * 访客不持有 UU 的任何凭证，也拿不到被控机的直连地址。
 */
export class ShareGuestSession {
  private readonly options: ShareGuestSessionOptions;
  private socket: WebSocket | null = null;
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(options: ShareGuestSessionOptions) {
    this.options = options;
  }

  connect(shareId: string, password: string): void {
    this.close();
    this.closed = false;
    this.options.onStatus("connecting", "正在连接…");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/share/${shareId}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", role: "guest", password }));
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: ShareServerMessage;
      try {
        message = JSON.parse(event.data) as ShareServerMessage;
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    socket.addEventListener("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.options.onStatus("closed", "连接已断开");
    });
  }

  sendInput(event: ShareInputEvent): void {
    if (this.channel?.readyState !== "open") return;
    try {
      this.channel.send(JSON.stringify(event));
    } catch {
      // 通道刚关闭，忽略。
    }
  }

  get inputReady(): boolean {
    return this.channel?.readyState === "open";
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    try {
      this.channel?.close();
      this.connection?.close();
    } catch {
      // 已经关闭。
    }
    this.channel = null;
    this.connection = null;
    this.pendingCandidates = [];
    if (this.stream) {
      this.stream = null;
      this.options.onStream(null);
    }
  }

  private handleMessage(message: ShareServerMessage): void {
    switch (message.type) {
      case "ready":
        this.options.onStatus("waiting-host", "已通过口令校验，等待画面…");
        return;
      case "auth-error":
        this.closed = true;
        this.options.onStatus("error", message.message);
        this.close();
        return;
      case "control":
        if (!message.enabled) this.options.onStatus("waiting-host", "主控端尚未开启分享画面");
        return;
      case "signal":
        void this.handleSignal(message.payload);
        return;
      case "error":
        this.options.onStatus("error", message.message);
        return;
      default:
        return;
    }
  }

  private async handleSignal(payload: ShareSignalPayload): Promise<void> {
    if (payload.kind === "offer") {
      const connection = this.ensureConnection();
      try {
        await connection.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      } catch {
        this.options.onStatus("error", "建立画面失败，请让主控端重新分享");
        return;
      }
      for (const candidate of this.pendingCandidates.splice(0)) {
        await connection.addIceCandidate(candidate).catch(() => undefined);
      }
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      this.send({ type: "signal", to: "host", payload: { kind: "answer", sdp: answer.sdp ?? "" } });
      return;
    }
    if (payload.kind === "ice") {
      const connection = this.connection;
      if (!connection || !connection.remoteDescription) {
        this.pendingCandidates.push(payload.candidate);
        return;
      }
      await connection.addIceCandidate(payload.candidate).catch(() => undefined);
    }
  }

  private ensureConnection(): RTCPeerConnection {
    if (this.connection) return this.connection;
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.connection = connection;

    connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.send({ type: "signal", to: "host", payload: { kind: "ice", candidate: event.candidate.toJSON() } });
    });

    connection.addEventListener("track", (event) => {
      const incoming = event.streams[0] ?? new MediaStream([event.track]);
      this.stream = incoming;
      this.options.onStream(incoming);
      this.options.onStatus("connected", "画面已连接");
    });

    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed") {
        this.options.onStatus("error", "与主控端的直连失败（可能被网络阻断）");
      }
    });

    // 数据通道由主控创建，访客这边只接收。
    connection.addEventListener("datachannel", (event) => {
      this.channel = event.channel;
      event.channel.addEventListener("open", () => {
        this.options.onStatus("connected", "已连接，可以操作");
      });
    });

    return connection;
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}
