import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OwnerGate } from "../src/components/OwnerGate.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(options: {
  authenticated: boolean;
  configured?: boolean;
  password?: string;
  mode?: "access" | "passphrase";
  email?: string;
  message?: string;
}) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/auth/session") {
      return jsonResponse({
        mode: options.mode ?? "passphrase",
        configured: options.configured ?? true,
        authenticated: options.authenticated,
        email: options.email ?? "",
        message: options.message ?? (options.configured === false ? "服务端还没设置登录口令。" : ""),
      });
    }
    if (path === "/api/auth/login") {
      const password = JSON.parse(String(init?.body)).password as string;
      if (password === options.password) return jsonResponse({ ok: true });
      return jsonResponse({ error: "口令不正确" }, 401);
    }
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OwnerGate", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the console when the browser already holds a valid session", async () => {
    stubFetch({ authenticated: true });
    render(
      <OwnerGate>
        <p>我的设备</p>
      </OwnerGate>,
    );

    await screen.findByText("我的设备");
    expect(screen.queryByRole("heading", { name: "登录控制台" })).not.toBeInTheDocument();
  });

  it("asks for the passphrase, reports a wrong one, then opens the console", async () => {
    stubFetch({ authenticated: false, password: "correct-horse" });
    const user = userEvent.setup();
    render(
      <OwnerGate>
        <p>我的设备</p>
      </OwnerGate>,
    );

    await screen.findByRole("heading", { name: "登录控制台" });
    // 未登录时绝不能渲染主控台内容，否则闸门形同虚设。
    expect(screen.queryByText("我的设备")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("访问口令"), "wrong-one");
    await user.click(screen.getByRole("button", { name: /进入控制台/ }));
    await screen.findByText("口令不正确");
    expect(screen.queryByText("我的设备")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("访问口令"));
    await user.type(screen.getByLabelText("访问口令"), "correct-horse");
    await user.click(screen.getByRole("button", { name: /进入控制台/ }));

    await screen.findByText("我的设备");
  });

  it("enters straight away when Cloudflare Access already vouched for the visitor", async () => {
    stubFetch({ authenticated: true, mode: "access", email: "owner@example.com" });
    render(
      <OwnerGate>
        <p>我的设备</p>
      </OwnerGate>,
    );

    await screen.findByText("我的设备");
    // Access 模式下不该再出现「输口令」这一步，否则就是双重门。
    expect(screen.queryByLabelText("访问口令")).not.toBeInTheDocument();
  });

  it("asks to re-run the Access login instead of a passphrase when the JWT is missing", async () => {
    stubFetch({ authenticated: false, mode: "access", message: "这个请求没有通过 Cloudflare Access 校验。" });
    render(
      <OwnerGate>
        <p>我的设备</p>
      </OwnerGate>,
    );

    await screen.findByRole("heading", { name: "Cloudflare Access 没有放行" });
    expect(screen.queryByText("我的设备")).not.toBeInTheDocument();
    // Access 模式没有本地口令可输，给输入框只会误导。
    expect(screen.queryByLabelText("访问口令")).not.toBeInTheDocument();
  });

  it("shows deployment guidance instead of a password box when no passphrase is configured", async () => {
    stubFetch({ authenticated: false, configured: false });
    render(
      <OwnerGate>
        <p>我的设备</p>
      </OwnerGate>,
    );

    await screen.findByText("服务端还没设置登录口令。");
    // 没配口令时给输入框只会让人一直输错，所以直接给配置指引。
    expect(screen.queryByLabelText("访问口令")).not.toBeInTheDocument();
  });
});
