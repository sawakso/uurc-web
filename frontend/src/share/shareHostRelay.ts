import {
  parseShareInputEvent,
  type ShareInputEvent,
  type ShareServerMessage,
  type ShareSignalPayload,
} from "@uurc/shared/shareProtocol";

export type ShareHostStatus = "idle" | "starting" | "waiting" | "live" | "error";

export interface ShareHostState {
  status: ShareHostStatus;
  guests: number;
  message: string;
}

export interface ShareHostRelayOptions {
  getStream: () => MediaStream | null;
  onInput: (event: ShareInputEvent) => void;
  onChange: (state: ShareHostState) => void;
}

interface GuestPeer {
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
}

// 浏览器之间的 STUN：只用来发现公网地址，不做中继。
// 两端都在对称型 NAT 后时会连不上——这时需要 TURN，属于已知限制。
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * 主控侧的分享转发：把已经拿到的远端画面转给访客，并把访客的输入回放进现有的控制通道。
 * 访客拿不到 UU 的任何凭证，主控页面关闭即断流。
 */
export class ShareHostRelay {
  private readonly options: ShareHostRelayOptions;
  private socket: WebSocket | null = null;
  private shareId = "";
  private hostToken = "";
  private readonly peers = new Map<string, GuestPeer>();
  private state: ShareHostState = { status: "idle", guests: 0, message: "" };

  constructor(options: ShareHostRelayOptions) {
    this.options = options;
  }

  get shareUrl(): string {
    if (!this.shareId) return "";
    return `${location.origin}/share/${this.shareId}`;
  }

  async start(password: string): Promise<string> {
    this.stop();
    this.update({ status: "starting", guests: 0, message: "正在创建分享…" });

    // 创建口在 Access 保护的老前缀下：只有站点所有者能建分享。
    const response = await fetch("/api/remote/share/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      shareId?: string;
      hostToken?: string;
      error?: string;
    };
    if (!response.ok || !body.shareId || !body.hostToken) {
      this.update({ status: "error", guests: 0, message: body.error ?? "创建分享失败" });
      throw new Error(body.error ?? "创建分享失败");
    }

    this.shareId = body.shareId;
    this.hostToken = body.hostToken;
    this.openSocket();
    return this.shareUrl;
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    for (const guestId of [...this.peers.keys()]) this.closePeer(guestId);
    this.shareId = "";
    this.hostToken = "";
    this.update({ status: "idle", guests: 0, message: "" });
  }

  /** 画面源变化（重新连接、切换画面）时重新协商，访客不用刷新。 */
  refreshStream(): void {
    if (!this.socket) return;
    for (const [guestId, peer] of this.peers) {
      this.attachTracks(peer.connection);
      void this.sendOffer(guestId, peer);
    }
  }

  private openSocket(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/share/${this.shareId}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      // 主控令牌自证身份：即使整条 /api/share 被 Access 放行，别人也拿不到它。
      socket.send(JSON.stringify({ type: "auth", role: "host", hostToken: this.hostToken }));
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
      if (this.socket !== socket) return;
      this.socket = null;
      for (const guestId of [...this.peers.keys()]) this.closePeer(guestId);
      this.update({ status: "idle", guests: 0, message: "分享已结束" });
    });
  }

  private handleMessage(message: ShareServerMessage): void {
    switch (message.type) {
      case "ready":
        this.update({ status: "waiting", guests: 0, message: "分享已开启，把链接和口令发给对方" });
        return;
      case "auth-error":
        this.update({ status: "error", guests: 0, message: message.message });
        return;
      case "guest-joined":
        void this.openPeer(message.guestId);
        return;
      case "guest-left":
        this.closePeer(message.guestId);
        this.update({ ...this.state, guests: this.peers.size });
        return;
      case "signal":
        void this.handleSignal(message.from, message.payload);
        return;
      default:
        return;
    }
  }

  private async openPeer(guestId: string): Promise<void> {
    this.closePeer(guestId);
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: GuestPeer = { connection, channel: null, pendingCandidates: [] };
    this.peers.set(guestId, peer);

    this.attachTracks(connection);

    // 主控发起数据通道：访客的输入从这里回来。
    const channel = connection.createDataChannel("input", { ordered: true });
    peer.channel = channel;
    channel.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const input = parseShareInputEvent(parsed);
      if (input) this.options.onInput(input);
    });

    connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.send({ type: "signal", to: guestId, payload: { kind: "ice", candidate: event.candidate.toJSON() } });
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        this.closePeer(guestId);
        this.update({ ...this.state, guests: this.peers.size });
        return;
      }
      if (connection.connectionState === "connected") {
        this.update({
          status: "live",
          guests: this.peers.size,
          message: `${this.peers.size} 位访客正在观看`,
        });
      }
    });

    await this.sendOffer(guestId, peer);
  }

  private attachTracks(connection: RTCPeerConnection): void {
    const stream = this.options.getStream();
    if (!stream) return;
    const existing = new Set(connection.getSenders().map((sender) => sender.track));
    for (const track of stream.getTracks()) {
      if (existing.has(track)) continue;
      try {
        connection.addTrack(track, stream);
      } catch {
        // 轨道已结束或已被替换，忽略。
      }
    }
  }

  private async sendOffer(guestId: string, peer: GuestPeer): Promise<void> {
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      this.send({ type: "signal", to: guestId, payload: { kind: "offer", sdp: offer.sdp ?? "" } });
    } catch {
      this.closePeer(guestId);
    }
  }

  private async handleSignal(from: string, payload: ShareSignalPayload): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;
    if (payload.kind === "answer") {
      try {
        await peer.connection.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      } catch {
        return;
      }
      for (const candidate of peer.pendingCandidates.splice(0)) {
        await peer.connection.addIceCandidate(candidate).catch(() => undefined);
      }
      return;
    }
    if (payload.kind === "ice") {
      if (!peer.connection.remoteDescription) {
        peer.pendingCandidates.push(payload.candidate);
        return;
      }
      await peer.connection.addIceCandidate(payload.candidate).catch(() => undefined);
    }
  }

  private closePeer(guestId: string): void {
    const peer = this.peers.get(guestId);
    if (!peer) return;
    this.peers.delete(guestId);
    try {
      peer.channel?.close();
      peer.connection.close();
    } catch {
      // 已经关闭。
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private update(next: ShareHostState): void {
    this.state = next;
    this.options.onChange(next);
  }
}
