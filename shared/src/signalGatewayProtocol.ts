import {
  STREAMER_CONTROL_EVENT_ACK_TIMEOUT_MS,
  STREAMER_CONTROL_EVENT_NAME,
  STREAMER_CONTROL_EVENT_PAYLOAD_KEYS,
  STREAMER_CONTROL_EVENT_PAYLOAD_TYPES,
  STREAMER_CONTROL_EVENT_WIRE_ARGUMENT_ORDER,
  STREAMER_CONTROL_STREAMER_DATA_JSON_KEYS,
  STREAMER_CONTROLLER_INBOUND_SOAC_TYPES,
  STREAMER_ICE_NETWORK_TYPES,
  STREAMER_SIGNAL_SOCKET_EVENTS,
  STREAMER_SOAC_EVENT,
  STREAMER_SOAC_TYPES,
  buildStreamerSoacPayload,
  type StreamerIceNetworkType,
  type StreamerSoacType,
} from "./streamerProtocol.js";
import type {
  RemoteSignalControlRequest,
  RemoteSignalGatewayStartRequest,
  RemoteSignalGatewayStatus,
  RemoteSignalSoacCandidate,
  RemoteSignalSoacRequest,
  StreamerRoomConfig,
} from "./types.js";

export const SIGNAL_GATEWAY_MAX_EVENTS = 200;

// 单条信令请求的规模上限。SDP / ICE 都是 KB 级，超过阈值基本可以判定为滥用。
export const MAX_SDP_LENGTH = 65_536;
export const MAX_APP_CONTROL_ID_LENGTH = 128;
export const MAX_APP_DATA_BASE64_LENGTH = 1_048_576;
export const MAX_STREAMER_DATA_LENGTH = 65_536;
export const MAX_SIGNAL_CANDIDATE_LENGTH = 2_048;
export const MAX_SIGNAL_SERVERS = 8;
export const MAX_SIGNAL_SERVER_URL_LENGTH = 512;

export class RemoteSignalValidationError extends Error {}

export interface SignalGatewayBinaryCodec<TBinary> {
  decodeBase64(value: string | undefined): TBinary;
  toBinary(value: unknown): TBinary | null;
  byteLength(value: TBinary): number;
  encodeBase64(value: TBinary): string;
  gzipText(value: string): TBinary;
  gunzipText(value: unknown): string | null;
}

export interface AsyncSignalGatewayBinaryCodec<TBinary> extends Omit<SignalGatewayBinaryCodec<TBinary>, "gzipText" | "gunzipText"> {
  gzipText(value: string): Promise<TBinary> | TBinary;
  gunzipText(value: unknown): Promise<string | null> | string | null;
}

export function orderSignalGatewayServers(signalServers: string[], preferredIndex: number | undefined): string[] {
  if (
    preferredIndex === undefined ||
    !Number.isInteger(preferredIndex) ||
    preferredIndex < 0 ||
    preferredIndex >= signalServers.length
  ) {
    return signalServers;
  }
  return [
    signalServers[preferredIndex],
    ...signalServers.slice(0, preferredIndex),
    ...signalServers.slice(preferredIndex + 1),
  ];
}

export function createIdleSignalGatewayStatus(updatedAt = new Date().toISOString()): RemoteSignalGatewayStatus {
  return {
    status: "idle",
    strategy: "backend_signal_gateway",
    signalServers: [],
    signalHeaders: {},
    signalControl: buildSignalGatewayControlStatus(),
    updatedAt,
  };
}

export function createSignalGatewayStatus({
  status,
  roomConfig,
  rawHeaders,
  startedAt,
  connectionId,
  error,
  selectedSignalServer,
  updatedAt = new Date().toISOString(),
}: {
  status: RemoteSignalGatewayStatus["status"];
  roomConfig: StreamerRoomConfig;
  rawHeaders: Record<string, string>;
  startedAt: string;
  connectionId?: string;
  error?: string;
  selectedSignalServer?: string;
  updatedAt?: string;
}): RemoteSignalGatewayStatus {
  return {
    status,
    strategy: "backend_signal_gateway",
    selectedSignalServer: selectedSignalServer ?? roomConfig.signalServers[0],
    signalServers: roomConfig.signalServers,
    signalHeaders: redactSignalGatewayHeaders(rawHeaders),
    signalControl: buildSignalGatewayControlStatus(),
    connectionId,
    startedAt,
    updatedAt,
    error,
  };
}

export function buildSignalGatewayControlStatus(): RemoteSignalGatewayStatus["signalControl"] {
  return {
    socketEvents: STREAMER_SIGNAL_SOCKET_EVENTS,
    event: STREAMER_CONTROL_EVENT_NAME,
    payloadKeys: STREAMER_CONTROL_EVENT_PAYLOAD_KEYS,
    payloadTypes: STREAMER_CONTROL_EVENT_PAYLOAD_TYPES,
    wireArgumentOrder: STREAMER_CONTROL_EVENT_WIRE_ARGUMENT_ORDER,
    streamerDataJsonKeys: STREAMER_CONTROL_STREAMER_DATA_JSON_KEYS,
    ackTimeoutMs: STREAMER_CONTROL_EVENT_ACK_TIMEOUT_MS,
  };
}

export function redactSignalGatewayHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "X-NRD-AUTH": "<redacted room token>",
  };
}

export function redactSignalGatewayToken(message: string, token: string): string {
  return token ? message.split(token).join("<redacted room token>") : message;
}

export function buildSignalGatewayControlPayload<TBinary>(
  input: RemoteSignalControlRequest,
  binary: Pick<SignalGatewayBinaryCodec<TBinary>, "decodeBase64">,
): Record<string, unknown> {
  return {
    app_control_id: input.appControlId,
    app_data: binary.decodeBase64(input.appDataBase64),
    streamer_data: input.streamerData ?? "",
  };
}

export function buildSignalGatewaySoacPayload<TBinary>(
  input: RemoteSignalSoacRequest,
  binary: Pick<SignalGatewayBinaryCodec<TBinary>, "gzipText">,
): Record<string, unknown> {
  const payload = buildStreamerSoacPayload(input) as unknown as Record<string, unknown>;
  if (shouldCompressSignalSdp(input)) {
    const data = payload.data as Record<string, unknown>;
    data.sdp = "";
    data.gzip_sdp = binary.gzipText(input.sdp);
  }
  return payload;
}

export async function buildSignalGatewaySoacPayloadAsync<TBinary>(
  input: RemoteSignalSoacRequest,
  binary: Pick<AsyncSignalGatewayBinaryCodec<TBinary>, "gzipText">,
): Promise<Record<string, unknown>> {
  const payload = buildStreamerSoacPayload(input) as unknown as Record<string, unknown>;
  if (shouldCompressSignalSdp(input)) {
    const data = payload.data as Record<string, unknown>;
    data.sdp = "";
    data.gzip_sdp = await binary.gzipText(input.sdp);
  }
  return payload;
}

export function normalizeSignalGatewayPayload<TBinary>(
  value: unknown,
  binary: Pick<SignalGatewayBinaryCodec<TBinary>, "toBinary" | "byteLength" | "encodeBase64">,
): unknown {
  const bytes = binary.toBinary(value);
  if (bytes) {
    return {
      kind: "binary",
      byteLength: binary.byteLength(bytes),
      base64: binary.encodeBase64(bytes),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeSignalGatewayPayload(item, binary));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeSignalGatewayPayload(item, binary)]),
    );
  }

  return value;
}

export function normalizeSignalGatewayInboundEvents<TBinary>(
  event: string,
  payload: unknown[],
  binary: Pick<SignalGatewayBinaryCodec<TBinary>, "gunzipText">,
): Array<{ event: string; payload: unknown }> {
  if (event !== STREAMER_SIGNAL_SOCKET_EVENTS.bmsgPush) {
    if (isControllerInboundSoacType(event)) {
      return [{
        event: STREAMER_SOAC_EVENT,
        payload: payload.map((item) => normalizeInboundTypedPayload(event, item, binary)),
      }];
    }
    return [{ event, payload: normalizeInboundTypedPayload(event, payload, binary) }];
  }

  const pushes = payload.map(parseSignalPush).filter((item) => item !== null);
  if (pushes.length === 0) {
    return [{ event, payload }];
  }

  return [
    { event, payload },
    ...pushes.map((push) => {
      const normalizedEvent = isControllerInboundSoacType(push.type) ? STREAMER_SOAC_EVENT : push.type;
      const data = isControllerInboundSoacType(push.type)
        ? normalizeTypedSoacPushPayload(push.type, push.data)
        : push.data;
      return {
        event: normalizedEvent,
        payload: data === undefined ? [] : [normalizeInboundTypedPayload(normalizedEvent, data, binary)],
      };
    }),
  ];
}

export async function normalizeSignalGatewayInboundEventsAsync<TBinary>(
  event: string,
  payload: unknown[],
  binary: Pick<AsyncSignalGatewayBinaryCodec<TBinary>, "gunzipText">,
): Promise<Array<{ event: string; payload: unknown }>> {
  if (event !== STREAMER_SIGNAL_SOCKET_EVENTS.bmsgPush) {
    if (isControllerInboundSoacType(event)) {
      return [{
        event: STREAMER_SOAC_EVENT,
        payload: await Promise.all(payload.map((item) => normalizeInboundTypedPayloadAsync(event, item, binary))),
      }];
    }
    return [{ event, payload: await normalizeInboundTypedPayloadAsync(event, payload, binary) }];
  }

  const pushes = payload.map(parseSignalPush).filter((item) => item !== null);
  if (pushes.length === 0) {
    return [{ event, payload }];
  }

  const normalized = await Promise.all(pushes.map(async (push) => {
    const normalizedEvent = isControllerInboundSoacType(push.type) ? STREAMER_SOAC_EVENT : push.type;
    const data = isControllerInboundSoacType(push.type)
      ? normalizeTypedSoacPushPayload(push.type, push.data)
      : push.data;
    return {
      event: normalizedEvent,
      payload: data === undefined ? [] : [await normalizeInboundTypedPayloadAsync(normalizedEvent, data, binary)],
    };
  }));
  return [
    { event, payload },
    ...normalized,
  ];
}

export function normalizeSignalGatewayRoomConfig(value: unknown): StreamerRoomConfig | null {
  const record = asRecord(value);
  if (!record || typeof record.token !== "string" || record.token.length === 0) return null;
  if (!Array.isArray(record.signalServers)) return null;
  const signalServers = record.signalServers
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .filter((item) => isSafeSignalServerUrl(item))
    .slice(0, MAX_SIGNAL_SERVERS);
  if (signalServers.length === 0) return null;
  return {
    token: record.token,
    signalServers,
    timeout: readOptionalNumber(record.timeout),
    signalReconnectDelay: readOptionalNumber(record.signalReconnectDelay),
    reportToken: readOptionalString(record.reportToken),
    reportUrl: readOptionalString(record.reportUrl),
    reportServerAddress: readOptionalString(record.reportServerAddress),
    appData: readOptionalString(record.appData),
  };
}

// 信令服务器由上游 join 响应下发，但请求体完全由调用方控制，
// 因此这里必须挡住内网/回环/元数据地址，否则 DO 会变成任意 WebSocket 出口。
export function isSafeSignalServerUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SIGNAL_SERVER_URL_LENGTH) return false;
  if (/[\s\\"'<>]/.test(value)) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return false;
  if (host === "metadata.google.internal") return false;
  if (isPrivateHostLiteral(host)) return false;

  return true;
}

function isPrivateHostLiteral(host: string): boolean {
  if (host.startsWith("[")) {
    const inner = host.slice(1, -1);
    if (inner === "::1" || inner === "::") return true;
    if (/^fe[89ab][0-9a-f]:/.test(inner)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(inner)) return true;
    if (inner.startsWith("::ffff:")) return true;
    return false;
  }

  const octets = host.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false;

  const [first, second] = octets.map(Number);
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first >= 224) return true;
  return false;
}

export function parseSignalGatewayStartRequest(body: unknown): RemoteSignalGatewayStartRequest {
  if (body !== undefined && body !== null && !asRecord(body)) {
    throw new RemoteSignalValidationError("Expected a JSON signal gateway payload");
  }
  const record = asRecord(body) ?? {};
  assertOptionalBoolean(record.gzipSdp, "gzipSdp");
  assertOptionalNonNegativeInteger(record.signalServerIndex, "signalServerIndex");

  const rawRoomConfig = record.roomConfig;
  if (rawRoomConfig === undefined || rawRoomConfig === null) {
    return {
      gzipSdp: record.gzipSdp as boolean | undefined,
      signalServerIndex: record.signalServerIndex as number | undefined,
    };
  }

  const roomConfig = normalizeSignalGatewayRoomConfig(rawRoomConfig);
  if (!roomConfig) {
    throw new RemoteSignalValidationError(
      "roomConfig.token is required and signalServers must contain public ws(s) URLs",
    );
  }

  return {
    gzipSdp: record.gzipSdp as boolean | undefined,
    signalServerIndex: record.signalServerIndex as number | undefined,
    roomConfig,
  };
}

export function parseSignalControlRequest(body: unknown): RemoteSignalControlRequest {
  const record = asRecord(body);
  if (!record) throw new RemoteSignalValidationError("Expected a JSON control payload");

  const appControlId = record.appControlId;
  if (typeof appControlId !== "string" || appControlId.length === 0) {
    throw new RemoteSignalValidationError("appControlId is required");
  }
  if (appControlId.length > MAX_APP_CONTROL_ID_LENGTH) {
    throw new RemoteSignalValidationError("appControlId is too long");
  }
  if (hasControlCharacters(appControlId)) {
    throw new RemoteSignalValidationError("appControlId contains control characters");
  }

  const appDataBase64 = record.appDataBase64;
  if (appDataBase64 !== undefined) {
    if (typeof appDataBase64 !== "string") {
      throw new RemoteSignalValidationError("appDataBase64 must be a base64 string");
    }
    if (appDataBase64.length > MAX_APP_DATA_BASE64_LENGTH) {
      throw new RemoteSignalValidationError("appDataBase64 is too large");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(appDataBase64)) {
      throw new RemoteSignalValidationError("appDataBase64 must be a base64 string");
    }
  }

  const streamerData = record.streamerData;
  if (streamerData !== undefined) {
    if (typeof streamerData !== "string") {
      throw new RemoteSignalValidationError("streamerData must be a string");
    }
    if (streamerData.length > MAX_STREAMER_DATA_LENGTH) {
      throw new RemoteSignalValidationError("streamerData is too large");
    }
  }

  return {
    appControlId,
    appDataBase64: appDataBase64 as string | undefined,
    streamerData: streamerData as string | undefined,
  };
}

export function parseSignalSoacRequest(body: unknown): RemoteSignalSoacRequest {
  const record = asRecord(body);
  if (!record) throw new RemoteSignalValidationError("Expected a JSON SOAC payload");

  if (!isStreamerSoacType(record.type)) {
    throw new RemoteSignalValidationError(`type must be one of ${STREAMER_SOAC_TYPES.join(", ")}`);
  }

  const clientId = readBoundedString(record.clientId, "clientId", MAX_APP_CONTROL_ID_LENGTH);
  const appControlId = readBoundedString(record.appControlId, "appControlId", MAX_APP_CONTROL_ID_LENGTH);
  const iceId = readBoundedString(record.iceId, "iceId", MAX_APP_CONTROL_ID_LENGTH);
  const sdp = readBoundedString(record.sdp, "sdp", MAX_SDP_LENGTH);
  assertOptionalBoolean(record.gzipSdp, "gzipSdp");

  let iceNetworkType: StreamerIceNetworkType | undefined;
  if (record.iceNetworkType !== undefined) {
    if (
      typeof record.iceNetworkType !== "number" ||
      !Number.isInteger(record.iceNetworkType) ||
      !Object.values(STREAMER_ICE_NETWORK_TYPES).includes(record.iceNetworkType as StreamerIceNetworkType)
    ) {
      throw new RemoteSignalValidationError("iceNetworkType must be a known streamer ICE network type");
    }
    iceNetworkType = record.iceNetworkType as StreamerIceNetworkType;
  }

  const candidate = parseSignalSoacCandidate(record.candidate);
  if (record.type === "candidate" && !candidate) {
    throw new RemoteSignalValidationError("candidate is required for SOAC candidate messages");
  }

  return {
    type: record.type,
    clientId,
    appControlId,
    iceId,
    sdp,
    gzipSdp: record.gzipSdp as boolean | undefined,
    iceNetworkType,
    candidate,
  };
}

function parseSignalSoacCandidate(value: unknown): RemoteSignalSoacCandidate | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) throw new RemoteSignalValidationError("candidate must be an object");
  if (typeof record.candidate !== "string" || record.candidate.length === 0) {
    throw new RemoteSignalValidationError("candidate.candidate is required");
  }
  if (record.candidate.length > MAX_SIGNAL_CANDIDATE_LENGTH) {
    throw new RemoteSignalValidationError("candidate.candidate is too long");
  }
  const sdpMid = readBoundedString(record.sdpMid, "candidate.sdpMid", MAX_APP_CONTROL_ID_LENGTH);

  let sdpMLineIndex: number | undefined;
  if (record.sdpMLineIndex !== undefined) {
    if (typeof record.sdpMLineIndex !== "number" || !Number.isInteger(record.sdpMLineIndex)) {
      throw new RemoteSignalValidationError("candidate.sdpMLineIndex must be an integer");
    }
    sdpMLineIndex = record.sdpMLineIndex;
  }

  return { candidate: record.candidate, sdpMid, sdpMLineIndex };
}

function isStreamerSoacType(value: unknown): value is StreamerSoacType {
  return typeof value === "string" && (STREAMER_SOAC_TYPES as readonly string[]).includes(value);
}

function readBoundedString(value: unknown, fieldName: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RemoteSignalValidationError(`${fieldName} must be a string`);
  if (value.length > maxLength) throw new RemoteSignalValidationError(`${fieldName} is too long`);
  return value;
}

function assertOptionalBoolean(value: unknown, fieldName: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new RemoteSignalValidationError(`${fieldName} must be a boolean`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertOptionalNonNegativeInteger(value: unknown, fieldName: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
    throw new RemoteSignalValidationError(`${fieldName} must be a non-negative integer`);
  }
}

function shouldCompressSignalSdp(input: RemoteSignalSoacRequest): input is RemoteSignalSoacRequest & { sdp: string } {
  return (
    (input.type === "offer" || input.type === "answer" || input.type === "restart_ice") &&
    input.gzipSdp === true &&
    typeof input.sdp === "string"
  );
}

function normalizeInboundTypedPayload<TBinary>(
  event: string,
  payload: unknown,
  binary: Pick<SignalGatewayBinaryCodec<TBinary>, "gunzipText">,
): unknown {
  const typedPayload = isControllerInboundSoacType(event) ? normalizeTypedSoacPushPayload(event, payload) : payload;
  if ((isControllerInboundSoacType(event) || event === STREAMER_SOAC_EVENT) && Array.isArray(typedPayload)) {
    return typedPayload.map((item) => normalizeInboundSoacPayload(item, binary));
  }
  if (!isControllerInboundSoacType(event) && event !== STREAMER_SOAC_EVENT) return typedPayload;
  return normalizeInboundSoacPayload(typedPayload, binary);
}

async function normalizeInboundTypedPayloadAsync<TBinary>(
  event: string,
  payload: unknown,
  binary: Pick<AsyncSignalGatewayBinaryCodec<TBinary>, "gunzipText">,
): Promise<unknown> {
  const typedPayload = isControllerInboundSoacType(event) ? normalizeTypedSoacPushPayload(event, payload) : payload;
  if ((isControllerInboundSoacType(event) || event === STREAMER_SOAC_EVENT) && Array.isArray(typedPayload)) {
    return Promise.all(typedPayload.map((item) => normalizeInboundSoacPayloadAsync(item, binary)));
  }
  if (!isControllerInboundSoacType(event) && event !== STREAMER_SOAC_EVENT) return typedPayload;
  return normalizeInboundSoacPayloadAsync(typedPayload, binary);
}

function normalizeInboundSoacPayload<TBinary>(
  payload: unknown,
  binary: Pick<SignalGatewayBinaryCodec<TBinary>, "gunzipText">,
): unknown {
  const soacData = getSoacData(payload);
  if (!soacData) return payload;
  const hasPlainSdp = typeof soacData.data.sdp === "string" && soacData.data.sdp.length > 0;
  if (hasPlainSdp) return payload;

  const plainSdp = binary.gunzipText(soacData.data.gzip_sdp) ?? binary.gunzipText(soacData.data.sdp);
  if (!plainSdp) return payload;
  return {
    ...soacData.record,
    data: {
      ...soacData.data,
      sdp: plainSdp,
    },
  };
}

async function normalizeInboundSoacPayloadAsync<TBinary>(
  payload: unknown,
  binary: Pick<AsyncSignalGatewayBinaryCodec<TBinary>, "gunzipText">,
): Promise<unknown> {
  const soacData = getSoacData(payload);
  if (!soacData) return payload;
  const hasPlainSdp = typeof soacData.data.sdp === "string" && soacData.data.sdp.length > 0;
  if (hasPlainSdp) return payload;

  const plainSdp = await binary.gunzipText(soacData.data.gzip_sdp) ?? await binary.gunzipText(soacData.data.sdp);
  if (!plainSdp) return payload;
  return {
    ...soacData.record,
    data: {
      ...soacData.data,
      sdp: plainSdp,
    },
  };
}

function getSoacData(payload: unknown): { record: Record<string, unknown>; data: Record<string, unknown> } | null {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  if (!record || !data) return null;
  return { record, data };
}

function parseSignalPush(value: unknown): { type: string; data?: unknown } | null {
  const parsed = parseJsonString(value) ?? parseWrappedSignalPush(value) ?? value;
  const record = asRecord(parsed);
  if (!record || typeof record.type !== "string" || record.type.length === 0) return null;
  return {
    type: record.type,
    data: record.data,
  };
}

function isControllerInboundSoacType(type: string): boolean {
  return STREAMER_CONTROLLER_INBOUND_SOAC_TYPES.includes(
    type as (typeof STREAMER_CONTROLLER_INBOUND_SOAC_TYPES)[number],
  );
}

function normalizeTypedSoacPushPayload(type: string, payload: unknown): unknown {
  const record = asRecord(payload);
  const soacData = asRecord(record?.data);
  if (!record || !soacData) return payload;
  if (typeof soacData.type === "string") return payload;
  return {
    ...record,
    data: {
      type,
      ...soacData,
    },
  };
}

function parseWrappedSignalPush(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return null;
  const wrapped = record._0 ?? record.onSignalPush;
  return parseJsonString(wrapped);
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
