import { useCallback, useEffect, useRef, useState } from "react";

import type { ShareInputEvent } from "@uurc/shared/shareProtocol";

import { ShareHostRelay, type ShareHostState, type ShareHostStatus } from "./shareHostRelay.js";

export interface ShareHostController extends ShareHostState {
  url: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  start: (password: string) => Promise<void>;
  stop: () => void;
  refreshStream: () => void;
}

export interface UseShareHostOptions {
  getStream: () => MediaStream | null;
  onInput: (event: ShareInputEvent) => void;
}

const IDLE: ShareHostState = { status: "idle", guests: 0, message: "" };

/** 主控侧的分享状态：创建/停止链接、访客数量、错误提示。 */
export function useShareHost(options: UseShareHostOptions): ShareHostController {
  const [state, setState] = useState<ShareHostState>(IDLE);
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const relayRef = useRef<ShareHostRelay | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ensureRelay = useCallback((): ShareHostRelay => {
    if (!relayRef.current) {
      relayRef.current = new ShareHostRelay({
        getStream: () => optionsRef.current.getStream(),
        onInput: (event) => optionsRef.current.onInput(event),
        onChange: (next) => setState(next),
      });
    }
    return relayRef.current;
  }, []);

  const start = useCallback(
    async (password: string) => {
      const relay = ensureRelay();
      try {
        const nextUrl = await relay.start(password);
        setUrl(nextUrl);
      } catch (error) {
        setState({
          status: "error",
          guests: 0,
          message: error instanceof Error ? error.message : "创建分享失败",
        });
      }
    },
    [ensureRelay],
  );

  const stop = useCallback(() => {
    relayRef.current?.stop();
    setUrl("");
  }, []);

  const refreshStream = useCallback(() => {
    relayRef.current?.refreshStream();
  }, []);

  useEffect(() => () => relayRef.current?.stop(), []);

  const status: ShareHostStatus = state.status;
  return { status, guests: state.guests, message: state.message, url, open, setOpen, start, stop, refreshStream };
}
