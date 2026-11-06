import { describe, expect, it } from "vitest";

import { parseShareClientMessage, parseShareInputEvent } from "../src/shareProtocol.js";

describe("share link wire protocol", () => {
  it("accepts a guest auth frame with a password", () => {
    expect(parseShareClientMessage(JSON.stringify({ type: "auth", role: "guest", password: "1234" }))).toEqual({
      type: "auth",
      role: "guest",
      password: "1234",
    });
  });

  it("rejects auth frames with an unknown role", () => {
    expect(parseShareClientMessage(JSON.stringify({ type: "auth", role: "admin" }))).toBeNull();
  });

  it("requires a target and a valid payload for signalling", () => {
    expect(parseShareClientMessage(JSON.stringify({ type: "signal", payload: { kind: "offer", sdp: "x" } }))).toBeNull();
    expect(
      parseShareClientMessage(JSON.stringify({ type: "signal", to: "g-1", payload: { kind: "offer", sdp: "v=0" } })),
    ).toEqual({ type: "signal", to: "g-1", payload: { kind: "offer", sdp: "v=0" } });
  });

  it("clamps pointer coordinates into the surface", () => {
    expect(parseShareInputEvent({ kind: "move", x: 1.7, y: -0.2 })).toEqual({ kind: "move", x: 1, y: 0 });
    expect(parseShareInputEvent({ kind: "move", x: Number.NaN, y: 0.5 })).toBeNull();
  });

  it("drops oversized text and out-of-range key codes", () => {
    expect(parseShareInputEvent({ kind: "text", text: "a".repeat(5000) })).toBeNull();
    expect(parseShareInputEvent({ kind: "text", text: "你好" })).toEqual({ kind: "text", text: "你好" });
    expect(parseShareInputEvent({ kind: "key", code: 9999, down: true })).toBeNull();
    expect(parseShareInputEvent({ kind: "key", code: 29, down: true })).toEqual({ kind: "key", code: 29, down: true });
  });
});
