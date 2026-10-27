import { describe, expect, it } from "vitest";

import {
  assertAllowedUuApiMethod,
  assertAllowedUuApiPath,
  isForwardableUuProxyHeader,
  pickForwardableUuResponseHeaders,
  sanitizeUuProxyHeaders,
} from "../src/uuProxy.js";
import {
  normalizeSignalGatewayRoomConfig,
  parseSignalControlRequest,
  parseSignalGatewayStartRequest,
  parseSignalSoacRequest,
  RemoteSignalValidationError,
} from "../src/signalGatewayProtocol.js";

describe("UU API 转发白名单", () => {
  it("放行前端实际使用的全部接口", () => {
    const allowed = [
      "/api/v1/security/mobile/code",
      "/api/v1/login/by_mobile",
      "/api/v1/device/android/init",
      "/api/v1/device/groups/of/my",
      "/api/v1/room/app_flag",
      "/api/v1/room/join/by_device/123456",
      "/api/v1/room/clear/by_device/123456",
      "/api/v2/room/join/share/by_code",
      "/api/v2/room/join/share/by_confirmation",
      "/api/v2/room/share/control_mode",
      "/api/v2/room/share/cancel_remote_assist",
    ];
    for (const path of allowed) {
      expect(() => assertAllowedUuApiPath(path), path).not.toThrow();
    }
  });

  it("拒绝未登记的一级接口，避免代理面被无限放大", () => {
    expect(() => assertAllowedUuApiPath("/api/v1/admin/reset")).toThrow("Unsupported UU API path");
    expect(() => assertAllowedUuApiPath("/api/v1/room/join/by_device/../../admin")).toThrow("Unsafe UU API path");
    expect(() => assertAllowedUuApiPath("/api/v1/room/join/by_device/a%2Fb")).toThrow("Unsupported UU API path");
    expect(() => assertAllowedUuApiPath("//evil.example/api/v1/login/by_mobile")).toThrow("Unsupported UU API path");
  });

  it("只允许 GET/POST", () => {
    expect(() => assertAllowedUuApiMethod("GET")).not.toThrow();
    expect(() => assertAllowedUuApiMethod("post")).not.toThrow();
    expect(() => assertAllowedUuApiMethod("DELETE")).toThrow("Unsupported UU API method");
    expect(() => assertAllowedUuApiMethod("TRACE")).toThrow("Unsupported UU API method");
  });

  it("不把本站 Cookie 与边缘身份头转发给上游", () => {
    const headers = sanitizeUuProxyHeaders({
      "X-Param-SIGN": "sig",
      Cookie: "uurc_auth=secret",
      "Cf-Access-Jwt-Assertion": "jwt",
      "Cf-Connecting-Ip": "1.2.3.4",
      "X-Forwarded-For": "1.2.3.4",
      Host: "evil.example",
    });
    expect(headers).toEqual({ "X-Param-SIGN": "sig" });
    expect(isForwardableUuProxyHeader("cookie")).toBe(false);
  });

  it("只回显白名单响应头", () => {
    const picked = pickForwardableUuResponseHeaders(
      new Headers({
        "content-type": "application/json",
        "set-cookie": "a=b",
        server: "nginx",
        date: "Mon, 26 Oct 2026 00:00:00 GMT",
      }),
    );
    expect(picked).toEqual({
      "content-type": "application/json",
      date: "Mon, 26 Oct 2026 00:00:00 GMT",
    });
  });
});

describe("信令服务器地址校验", () => {
  it("放行公网信令地址", () => {
    const config = normalizeSignalGatewayRoomConfig({
      token: "room-token",
      signalServers: ["wss://signal.example.com/socket.io", "https://1.2.3.4/socket.io"],
    });
    expect(config?.signalServers).toHaveLength(2);
  });

  it("拒绝回环、私网、链路本地与元数据地址", () => {
    const blocked = [
      "http://localhost:8080/socket.io",
      "http://127.0.0.1/socket.io",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/socket.io",
      "http://192.168.1.10/socket.io",
      "http://172.20.0.1/socket.io",
      "http://[::1]/socket.io",
      "http://[fd00::1]/socket.io",
      "http://metadata.google.internal/computeMetadata/v1",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ];
    for (const server of blocked) {
      expect(normalizeSignalGatewayRoomConfig({ token: "t", signalServers: [server] }), server).toBeNull();
    }
  });

  it("丢弃非法项后仍保留合法项，并限制数量", () => {
    const config = normalizeSignalGatewayRoomConfig({
      token: "t",
      signalServers: ["http://127.0.0.1/", "wss://a.example.com/socket.io", ...Array.from({ length: 10 }, (_, i) => `wss://s${i}.example.com/socket.io`)],
    });
    expect(config?.signalServers[0]).toBe("wss://a.example.com/socket.io");
    expect(config?.signalServers.length).toBeLessThanOrEqual(8);
  });
});

describe("信令请求体运行期校验", () => {
  it("start 拒绝把 DO 指向内网", () => {
    expect(() =>
      parseSignalGatewayStartRequest({ roomConfig: { token: "t", signalServers: ["http://192.168.1.1/"] } }),
    ).toThrow(RemoteSignalValidationError);
  });

  it("start 接受合法 roomConfig 并丢弃未知字段", () => {
    const parsed = parseSignalGatewayStartRequest({
      gzipSdp: true,
      roomConfig: { token: "t", signalServers: ["wss://signal.example.com/socket.io"], unknown: "x" },
    });
    expect(parsed.roomConfig?.token).toBe("t");
    expect(Object.keys(parsed.roomConfig ?? {})).not.toContain("unknown");
  });

  it("control 校验 appControlId 与 base64 载荷", () => {
    expect(() => parseSignalControlRequest({})).toThrow("appControlId is required");
    expect(() => parseSignalControlRequest({ appControlId: "a".repeat(200) })).toThrow("appControlId is too long");
    expect(() => parseSignalControlRequest({ appControlId: "a\nb" })).toThrow("control characters");
    expect(() => parseSignalControlRequest({ appControlId: "id", appDataBase64: "不是 base64" })).toThrow(
      "appDataBase64 must be a base64 string",
    );
    expect(parseSignalControlRequest({ appControlId: "id", appDataBase64: "YQ==" }).appDataBase64).toBe("YQ==");
  });

  it("soac 校验 type 与 candidate 必填项", () => {
    expect(() => parseSignalSoacRequest({ type: "bogus" })).toThrow("type must be one of");
    expect(() => parseSignalSoacRequest({ type: "candidate" })).toThrow("candidate is required");
    expect(parseSignalSoacRequest({ type: "offer", sdp: "v=0" }).sdp).toBe("v=0");
  });
});
