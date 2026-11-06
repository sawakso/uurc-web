import type { ShareInputEvent, ShareServerMessage, ShareSignalPayload } from "@uurc/shared/shareProtocol";

export type ShareGuestStatus = "connecting" | "waiting-host" | "connected" | "closed" | "error";

export interface ShareDiagnostics {
  /** 一句话说明当前画面为什么有/没有内容。 */
  summary: string;
  /** 视频是否真的在解码（false = 黑屏）。 */
  decoding: boolean;
}

export interface ShareGuestSessionOptions {
  onStatus: (status: ShareGuestStatus, message: string) => void;
  onStream: (stream: MediaStream | null) => void;
  onDiagnostics?: (diagnostics: ShareDiagnostics) => void;
  /** 操作权限变化：只有用控制口令换到权限后才能动鼠标键盘。 */
  onControlChange?: (canControl: boolean) => void;
  /** 不算致命错误的提示（例如控制口令输错），不该把页面打回口令页。 */
  onNotice?: (message: string) => void;
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
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private canControl = false;

  constructor(options: ShareGuestSessionOptions) {
    this.options = options;
  }

  connect(shareId: string, password: string): void {
    this.close();
    this.closed = false;
    this.canControl = false;
    this.options.onControlChange?.(false);
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

  /** 用控制口令换操作权限；换到之前只能看。 */
  requestControl(password: string): void {
    this.send({ type: "control-auth", password });
  }

  get controlEnabled(): boolean {
    return this.canControl;
  }

  sendInput(event: ShareInputEvent): void {
    if (!this.canControl) return;
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
    this.canControl = false;
    this.stopStats();
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
        this.canControl = message.enabled;
        this.options.onControlChange?.(this.canControl);
        return;
      case "signal":
        void this.handleSignal(message.payload);
        return;
      case "error":
        // 例如控制口令输错：留在当前页面继续看，只给一条提示。
        this.options.onNotice?.(message.message);
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
      this.startStats();
    });

    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed") {
        this.options.onStatus("error", "与主控端的直连失败（两端都在对称 NAT 后时需要 TURN 中继）");
        this.stopStats();
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

  /** 每 2 秒读一次实时统计：黑屏时能看出是"没收到轨道"还是"收到但没数据"。 */
  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => void this.collectStats(), 2000);
    void this.collectStats();
  }

  private stopStats(): void {
    if (!this.statsTimer) return;
    clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private async collectStats(): Promise<void> {
    const connection = this.connection;
    const report = await connection?.getStats().catch(() => null);
    if (!connection || !report) return;

    let inboundVideo: RTCStats | null = null;
    let selectedPair: RTCStats | null = null;
    const candidates = new Map<string, { candidateType?: string }>();
    report.forEach((stat) => {
      if (stat.type === "inbound-rtp" && (stat as RTCInboundRtpStreamStats).kind === "video") inboundVideo = stat;
      if (stat.type === "candidate-pair" && (stat as RTCIceCandidatePairStats).state === "succeeded") selectedPair = stat;
      if (stat.type === "local-candidate" || stat.type === "remote-candidate") {
        candidates.set(stat.id, stat as unknown as { candidateType?: string });
      }
    });

    if (!inboundVideo) {
      this.options.onDiagnostics?.({
        summary:
          connection.connectionState === "connected"
            ? "连线已建立，但主控端没有送来视频轨（对方可能还没连接被控设备）"
            : `连线状态：${connection.connectionState}`,
        decoding: false,
      });
      return;
    }

    const video = inboundVideo as RTCInboundRtpStreamStats;
    const pair = selectedPair as RTCIceCandidatePairStats | null;
    const localType = pair ? candidates.get(pair.localCandidateId)?.candidateType : undefined;
    const remoteType = pair ? candidates.get(pair.remoteCandidateId)?.candidateType : undefined;
    const frames = video.framesDecoded ?? 0;
    const path = localType && remoteType ? `${localType}→${remoteType}` : "未知路径";

    if (frames === 0) {
      this.options.onDiagnostics?.({
        summary: `已收到视频轨（${video.frameWidth ?? 0}×${video.frameHeight ?? 0}），但还没有解码出画面；路径 ${path}`,
        decoding: false,
      });
      return;
    }

    this.options.onDiagnostics?.({
      summary: `${video.frameWidth ?? 0}×${video.frameHeight ?? 0} · 已解码 ${frames} 帧 · 路径 ${path}`,
      decoding: true,
    });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}
