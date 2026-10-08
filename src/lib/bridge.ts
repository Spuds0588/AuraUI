import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  applyAgentFrame,
  applyCanvasEvent,
  applyStatus,
  applyWelcome,
  clearOrphaned,
  createInitialState,
  dismissNotice,
  dismissTask,
  expireOrphaned,
  markOrphaned,
} from "./canvasStore";
import { DEMO_AGENT_IDENTITY, demoOpening, demoReply, type DemoFrame } from "./demoScript";
import { type AgentFrame, type CanvasState, type EventName } from "./protocol";

/**
 * The canvas side of the bridge.
 *
 * Two transports:
 *  - **desktop** — inside the Tauri shell. Agent frames arrive as `auraui://frame` events
 *    from the Rust bridge and answers go back through the `auraui_emit` command.
 *  - **demo** — a plain browser (`npm run dev`) with no Rust and no agent. A scripted agent
 *    walks through all eight component kinds so the renderer is still workable.
 *
 * The store is transport-agnostic; only this file knows the difference.
 */

export const FRAME_EVENT = "auraui://frame";
export const STATUS_EVENT = "auraui://status";

export type CanvasMode = "connecting" | "desktop" | "demo";

/** Mirror of Rust's `BridgeStatus`. */
export interface BridgeStatusPayload {
  sessionId: string;
  bridgeUrl: string;
  running: boolean;
  connections: CanvasState["connected"];
  received: number;
  emitted: number;
}

/** True when the page is running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useCanvas() {
  const [state, setState] = useState<CanvasState>(() => createInitialState());
  const [mode, setMode] = useState<CanvasMode>("connecting");
  const [running, setRunning] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const handle of timers.current) window.clearTimeout(handle);
    timers.current = [];
  }, []);

  /** Queue demo frames with cumulative delays, so a batch plays in order. */
  const schedule = useCallback((frames: DemoFrame[]) => {
    let elapsed = 0;
    for (const item of frames) {
      elapsed += item.delay;
      const handle = window.setTimeout(() => {
        setState((current) => applyAgentFrame(current, item.frame));
      }, elapsed);
      timers.current.push(handle);
    }
  }, []);

  const startDemo = useCallback(() => {
    const sessionId = `demo-${Math.random().toString(36).slice(2, 8)}`;
    setMode("demo");
    setRunning(true);
    setState((current) =>
      applyWelcome(createInitialState(current.bridgeUrl), {
        sessionId,
        bridgeUrl: `ws://127.0.0.1:9090 (scripted, in-browser)`,
      }),
    );

    const connectHandle = window.setTimeout(() => {
      setState((current) =>
        applyStatus(current, {
          sessionId,
          bridgeUrl: current.bridgeUrl,
          connections: [{ id: "demo-agent", identity: DEMO_AGENT_IDENTITY, since: Date.now() }],
        }),
      );
    }, 200);
    timers.current.push(connectHandle);

    schedule(demoOpening());
  }, [schedule]);

  // Desktop transport.
  useEffect(() => {
    if (!isTauri()) {
      startDemo();
      return clearTimers;
    }

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const attach = async () => {
      try {
        unlisteners.push(
          await listen<AgentFrame>(FRAME_EVENT, (event) => {
            setState((current) => applyAgentFrame(current, event.payload));
          }),
        );
        unlisteners.push(
          await listen<BridgeStatusPayload>(STATUS_EVENT, (event) => {
            setRunning(event.payload.running);
            setState((current) => applyStatus(current, event.payload));
          }),
        );

        const status = await invoke<BridgeStatusPayload>("auraui_status");
        if (disposed) return;
        setRunning(status.running);
        setState((current) => applyStatus(current, status));

        // Tell the bridge a human is looking, which flushes anything queued while the
        // window was still loading.
        await invoke("auraui_attach");
        if (!disposed) setMode("desktop");
      } catch (error) {
        if (!disposed) setFatal(`Could not attach to the AuraUI bridge: ${String(error)}`);
      }
    };

    void attach();

    const detach = () => {
      void invoke("auraui_detach").catch(() => undefined);
    };
    window.addEventListener("beforeunload", detach);

    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", detach);
      for (const unlisten of unlisteners) unlisten();
      clearTimers();
    };
  }, [clearTimers, startDemo]);

  const respond = useCallback(
    (taskId: string, event: EventName, payload?: unknown) => {
      setState((current) => applyCanvasEvent(current, { taskId, event, payload }));

      if (mode === "demo") {
        const actionId = (payload as { actionId?: string } | undefined)?.actionId;
        if (taskId === "wrap-up" && actionId === "again") {
          clearTimers();
          startDemo();
          return;
        }
        schedule(demoReply(taskId, event, payload));
        return;
      }

      void invoke("auraui_emit", { taskId, event, payload: payload ?? {} }).catch((error) =>
        setFatal(`Could not send the answer to the bridge: ${String(error)}`),
      );
    },
    [clearTimers, mode, schedule, startDemo],
  );

  const dismiss = useCallback((taskId: string) => {
    setState((current) => dismissTask(current, taskId));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setState((current) => dismissNotice(current, id));
  }, []);

  /*
   * Questions with nobody left to answer them.
   *
   * The bridge is a router: when the last agent disconnects there is no socket for an answer
   * to travel down, so a card still on screen is a control that silently eats clicks. This
   * marks it the moment the connection count hits zero, counts it down in `secondsUntilExpiry`
   * and drops it here when the grace period is out. A reconnect inside the window clears the
   * mark instead, which is why the human is given the countdown rather than an instant exit.
   */
  const orphaned = running && mode === "desktop" && state.connected.length === 0;

  useEffect(() => {
    setState((current) => (orphaned ? markOrphaned(current) : clearOrphaned(current)));
    if (!orphaned) return;

    const handle = window.setInterval(() => {
      setState((current) => expireOrphaned(current));
    }, 1000);
    return () => window.clearInterval(handle);
  }, [orphaned]);

  return {
    state,
    mode,
    running,
    fatal,
    respond,
    dismiss,
    dismissToast,
  } as const;
}

export type CanvasApi = ReturnType<typeof useCanvas>;
