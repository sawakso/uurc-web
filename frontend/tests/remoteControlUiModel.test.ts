// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { getStageLocalCursorAnchor, toRemoteMousePosition, toStageLocalCursorPoint } from "../src/remote/remoteControlUiModel.js";

describe("toRemoteMousePosition", () => {
  it("maps against the active (primary) video, not the first hidden tile", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 500);

    // 第一个(隐藏)tile 分辨率与显示中的不同，用于暴露“取第一个 video”的偏移 bug。
    const hidden = document.createElement("video");
    defineVideoSize(hidden, 4000, 2000);
    const active = document.createElement("video");
    active.setAttribute("data-active", "true");
    defineVideoSize(active, 1000, 500);
    stage.append(hidden, active);

    const result = toRemoteMousePosition({
      clientX: 500,
      clientY: 250,
      currentTarget: stage as unknown as HTMLDivElement,
    });

    expect(result.surfaceWidth).toBe(1000);
    expect(result.surfaceHeight).toBe(500);
    expect(result.absX).toBe(500);
    expect(result.absY).toBe(250);
  });

  it("falls back to the first video when none is marked active", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    const only = document.createElement("video");
    defineVideoSize(only, 1600, 1200);
    stage.append(only);

    const result = toRemoteMousePosition({
      clientX: 400,
      clientY: 300,
      currentTarget: stage as unknown as HTMLDivElement,
    });

    expect(result.surfaceWidth).toBe(1600);
    expect(result.surfaceHeight).toBe(1200);
  });
});

describe("toStageLocalCursorPoint", () => {
  it("returns stage-local coordinates when the video fills the stage", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 500);
    const video = document.createElement("video");
    defineVideoSize(video, 2000, 1000);
    stage.append(video);

    expect(toStageLocalCursorPoint(stage, 250, 125)).toEqual({ x: 250, y: 125 });
  });

  it("pins the arrow to the picture edge when the pointer is inside the letterbox bar", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 500);
    const video = document.createElement("video");
    // 4:4 的画面放进 2:1 的框：左右各 250px 黑边，内容区 x∈[250,750]。
    defineVideoSize(video, 1000, 1000);
    stage.append(video);

    expect(toStageLocalCursorPoint(stage, 10, 200)).toEqual({ x: 250, y: 200 });
    expect(toStageLocalCursorPoint(stage, 500, 250)).toEqual({ x: 500, y: 250 });
  });

  it("returns null before the stage has usable dimensions", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

    expect(toStageLocalCursorPoint(stage, 10, 10)).toBeNull();
  });
});

describe("getStageLocalCursorAnchor", () => {
  it("anchors at the center of the letterboxed picture, not the stage", () => {
    const stage = document.createElement("div");
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 500);
    const video = document.createElement("video");
    defineVideoSize(video, 1000, 1000);
    stage.append(video);

    expect(getStageLocalCursorAnchor(stage)).toEqual({ x: 500, y: 250 });
  });
});

function defineVideoSize(video: HTMLVideoElement, width: number, height: number): void {
  Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
}
