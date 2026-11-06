import { describe, expect, it } from "vitest";

import { toAndroidKeyCodeFromDomEvent } from "../src/remote/androidKeyCodes.js";

describe("Android source keycode mapping for streamer input", () => {
  it("maps printable DOM codes to Android KeyEvent codes used by the App input transformer", () => {
    expect(toAndroidKeyCodeFromDomEvent({ code: "KeyA", key: "a" })).toBe(29);
    expect(toAndroidKeyCodeFromDomEvent({ code: "KeyZ", key: "z" })).toBe(54);
    expect(toAndroidKeyCodeFromDomEvent({ code: "Digit0", key: "0" })).toBe(7);
    expect(toAndroidKeyCodeFromDomEvent({ code: "Digit9", key: "9" })).toBe(16);
  });

  it("maps navigation and editing keys to Android KeyEvent codes", () => {
    expect(toAndroidKeyCodeFromDomEvent({ code: "Enter", key: "Enter" })).toBe(66);
    expect(toAndroidKeyCodeFromDomEvent({ code: "Backspace", key: "Backspace" })).toBe(67);
    expect(toAndroidKeyCodeFromDomEvent({ code: "ArrowLeft", key: "ArrowLeft" })).toBe(21);
    expect(toAndroidKeyCodeFromDomEvent({ code: "ArrowRight", key: "ArrowRight" })).toBe(22);
    expect(toAndroidKeyCodeFromDomEvent({ code: "Space", key: " " })).toBe(62);
  });

  // 未收录的键一律丢弃：以前会把 event.key 当键码发出去，
  // 被控端按字符解析时可能误触发真实按键（大写锁死、字母大小写漂移就是这么来的）。
  it("drops unlisted keys instead of forwarding raw DOM key names", () => {
    expect(toAndroidKeyCodeFromDomEvent({ code: "Unidentified", key: "AudioVolumeUp" })).toBeUndefined();
    expect(toAndroidKeyCodeFromDomEvent({ code: "CapsLock", key: "CapsLock" })).toBeUndefined();
  });

  it("maps the numeric keypad so its operators and Enter work", () => {
    expect(toAndroidKeyCodeFromDomEvent({ code: "NumpadEnter", key: "Enter" })).toBe(160);
    expect(toAndroidKeyCodeFromDomEvent({ code: "NumpadAdd", key: "+" })).toBe(157);
    expect(toAndroidKeyCodeFromDomEvent({ code: "NumpadDecimal", key: "." })).toBe(158);
  });
});
