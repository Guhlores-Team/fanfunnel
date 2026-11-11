"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpinResult } from "@/lib/games/wheel/types";
import { randomUuid } from "@/lib/fan/uuid";
import { spinErrorInfo } from "../spinErrors";
import { browserSpinIntentStore, classifySpinStatus, finishBrowserSpinIntent, isTransportFailure, persistBrowserSpinIntent,
  readBrowserSpinIntent, spinIntentBody, SPIN_RECOVERY_COPY, TERMINAL_SPIN_REFUSALS, type BrowserSpinIntent, type SpinIntentStore } from "./spinIntent";
import { currentInAppBrowser } from "./inAppBrowser";

/** FD-5: inside an app's browser there are no site settings to point at. */
const storageMessage = () => currentInAppBrowser() ? SPIN_RECOVERY_COPY.storageInApp : SPIN_RECOVERY_COPY.storage;

/** RF-06: `Retry-After` (seconds) on a 429/503, as milliseconds; null when absent or unreadable. */
export function retryAfterMs(response: { headers?: { get?: (name: string) => string | null } } | null | undefined): number | null {
  const raw = response?.headers?.get?.("retry-after");
  if (typeof raw !== "string") return null;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

export interface SpinRefusalDetail {
  /** The saved request was released: the fan can play again (after any cooldown). */
  terminal: boolean;
  retryAfterMs: number | null;
}

async function postIntent(path: string, token: string, intent: BrowserSpinIntent) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
      cache: "no-store", signal: controller.signal, body: JSON.stringify(spinIntentBody(token, intent)) });
    const data = await response.json();
    return { response, data };
  } finally { clearTimeout(timeout); }
}

/** A status read can recover a play, but can never start another one. */
export function useSpinRecovery({ token, canRetry, onCommitted, onRefusal, onReleased, validateResult }: {
  token: string;
  canRetry: boolean;
  onCommitted: (result: SpinResult, options: { present: boolean; recovered: boolean }) => void;
  onRefusal: (code: unknown, detail: SpinRefusalDetail) => void;
  /** WF-09: another tab of this link finished the saved spin (declined it or closed its win card). */
  onReleased?: () => void;
  validateResult?: (result: unknown) => boolean;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "sending" | "pending" | "revealing" | "storage">("loading");
  const [message, setMessage] = useState<string | null>(null);
  // FD-13: the server said it has never seen this request, so the one useful
  // action is to send the same request again (it can only count once).
  const [absent, setAbsent] = useState(false);
  const store = useRef<SpinIntentStore | null>(null);
  const intent = useRef<BrowserSpinIntent | null>(null);
  // WF-09: the saved request was started by another tab of this link. Its
  // win is presented there; here it is only shown on an explicit check.
  const adopted = useRef(false);
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  const running = useRef(false);
  const presented = useRef(new Set<string>());
  const handlers = useRef({ canRetry, onCommitted, onRefusal, onReleased, validateResult });
  useEffect(() => { handlers.current = { canRetry, onCommitted, onRefusal, onReleased, validateResult }; }, [canRetry, onCommitted, onRefusal, onReleased, validateResult]);

  const apply = useCallback((data: SpinResult, id: string, recovered: boolean) => {
    if (data?.attemptId !== id || !data.prize || !Number.isInteger(data.prizeIndex)
      || !Number.isSafeInteger(data.spinsRemaining) || data.spinsRemaining < 0) throw new Error("Unconfirmed response");
    if (handlers.current.validateResult && !handlers.current.validateResult(data)) throw new Error("Unconfirmed game presentation");
    const present = !presented.current.has(id);
    handlers.current.onCommitted(data, { present, recovered: recovered || data.replayed === true });
    presented.current.add(id);
    setPhase("revealing");
    setMessage(null);
    setAbsent(false);
  }, []);

  /** The saved request is spent (declined, gone or finished elsewhere): release it. */
  const release = useCallback(async (requestId: string, copy: string | null, code: string | null, detail: SpinRefusalDetail) => {
    if (!store.current) return false;
    const cleared = await finishBrowserSpinIntent(store.current, requestId);
    if (!cleared) return false;
    intent.current = null;
    adopted.current = false;
    setPhase("ready");
    setAbsent(false);
    setMessage(copy);
    if (code !== null) handlers.current.onRefusal(code, detail);
    return true;
  }, []);

  const check = useCallback(async (options?: { manual?: boolean }) => {
    if (running.current || !intent.current) return;
    running.current = true;
    const saved = intent.current;
    try {
      const { response, data } = await postIntent("/api/spin/status", token, saved);
      const outcome = classifySpinStatus(data, response.ok, response.status);
      if (outcome.kind === "committed") {
        if (adopted.current && !options?.manual && !presented.current.has(saved.requestId)) {
          // WF-09: the other tab is showing this win; do not pop it here too.
          setPhase("pending");
          setAbsent(false);
          setMessage(SPIN_RECOVERY_COPY.elsewhere);
        } else {
          adopted.current = false;
          apply(outcome.result as SpinResult, saved.requestId, true);
        }
      } else if (outcome.kind === "declined" && store.current) {
        if (!await release(saved.requestId, spinErrorInfo(outcome.error).message, outcome.error, { terminal: true, retryAfterMs: null })) throw new Error("Another saved request exists");
      } else if (outcome.kind === "gone" && store.current) {
        // RS-13: the link (and so the attempt) no longer exists; nothing is owed.
        if (!await release(saved.requestId, SPIN_RECOVERY_COPY.gone, "not_found", { terminal: true, retryAfterMs: null })) throw new Error("Another saved request exists");
      } else {
        setPhase("pending");
        setAbsent(outcome.kind === "keep" && outcome.absent);
        setMessage(outcome.kind === "keep" ? outcome.message : SPIN_RECOVERY_COPY.unavailable);
        if (data.error) handlers.current.onRefusal(data.error, { terminal: false, retryAfterMs: retryAfterMs(response) });
      }
    } catch (error) {
      setPhase("pending");
      setAbsent(false);
      // RF-07: nothing reached the server, so say "offline", not "cannot check".
      setMessage(isTransportFailure(error) ? SPIN_RECOVERY_COPY.offline : SPIN_RECOVERY_COPY.unavailable);
    } finally { running.current = false; }
  }, [apply, release, token]);

  const initialize = useCallback(async (options?: { adopted?: boolean }) => {
    if (running.current) return;
    try {
      const nextStore = await browserSpinIntentStore(token);
      const saved = readBrowserSpinIntent(nextStore);
      store.current = nextStore;
      if (saved) {
        intent.current = saved;
        adopted.current = options?.adopted === true;
        setPhase("pending");
        setMessage(adopted.current ? SPIN_RECOVERY_COPY.elsewhere : SPIN_RECOVERY_COPY.pending);
        await check();
      } else if (!intent.current) { setPhase("ready"); setMessage(null); }
    } catch { setPhase("storage"); setMessage(storageMessage()); }
  }, [check, token]);

  useEffect(() => {
    const boot = setTimeout(() => void initialize(), 0);
    const resume = (adoptedElsewhere = false) => {
      if (document.visibilityState !== "hidden") {
        if (intent.current) void check(); else void initialize({ adopted: adoptedElsewhere });
      }
    };
    const changed = (event: StorageEvent) => {
      if (event.key !== store.current?.key) return;
      if (event.newValue === null && intent.current && phaseRef.current !== "revealing") {
        // WF-09: another tab declined this spin or closed its win card. This tab
        // never presents it again; it is in "Your wins" after the refresh.
        presented.current.add(intent.current.requestId);
        intent.current = null;
        adopted.current = false;
        setPhase("ready");
        setAbsent(false);
        setMessage(null);
        handlers.current.onReleased?.();
        return;
      }
      resume(true);
    };
    const wake = () => resume(false);
    window.addEventListener("online", wake);
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearTimeout(boot);
      window.removeEventListener("online", wake);
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [check, initialize]);

  const send = useCallback(async (saved: BrowserSpinIntent) => {
    if (running.current || !handlers.current.canRetry) return;
    running.current = true;
    setPhase("sending");
    setMessage(null);
    try {
      const { response, data } = await postIntent("/api/spin", token, saved);
      const code = typeof data?.error === "string" ? data.error : null;
      if (response.ok) apply(data, saved.requestId, false);
      else if (code === "blocked" && store.current && await finishBrowserSpinIntent(store.current, saved.requestId)) {
        // FD-3: the link or its creator is no longer active. The server opened
        // nothing for this request, so it is released, not left "being checked".
        intent.current = null;
        setPhase("ready");
        setAbsent(false);
        setMessage(spinErrorInfo("blocked").message);
        handlers.current.onRefusal("blocked", { terminal: true, retryAfterMs: null });
      } else if (code !== null && TERMINAL_SPIN_REFUSALS.includes(code) && store.current
        && await release(saved.requestId, spinErrorInfo(code).message, code, { terminal: true, retryAfterMs: retryAfterMs(response) })) {
        // RF-06: refused before anything was opened; the fan may play again.
      } else {
        handlers.current.onRefusal(data?.error, { terminal: false, retryAfterMs: retryAfterMs(response) });
        setPhase("pending");
        setAbsent(false);
        setMessage(spinErrorInfo(data?.error).message + " Check this spin before playing again.");
      }
    } catch (error) {
      setPhase("pending"); setAbsent(false);
      setMessage(isTransportFailure(error) ? SPIN_RECOVERY_COPY.offline : SPIN_RECOVERY_COPY.pending);
    }
    finally { running.current = false; }
  }, [apply, release, token]);

  const begin = useCallback(async (clientSeed: string, publishedSeedHash: string | null) => {
    if (running.current || !handlers.current.canRetry || !store.current) return;
    // The ref closes the same-tab double-tap gap before React updates.
    if (intent.current) { await check(); return; }
    running.current = true;
    setPhase("sending");
    let saved: BrowserSpinIntent;
    try {
      saved = await persistBrowserSpinIntent(store.current, { v: 1, requestId: randomUuid(), clientSeed,
        ...(publishedSeedHash ? { publishedSeedHash } : {}) });
      intent.current = saved;
      adopted.current = false;
    } catch {
      setPhase("storage"); setMessage(storageMessage());
      running.current = false;
      return;
    }
    running.current = false;
    await send(saved);
  }, [check, send]);
  const retry = useCallback(async () => {
    if (intent.current) await send(intent.current);
  }, [send]);
  const acknowledge = useCallback(async () => {
    if (!store.current || !intent.current) return;
    try {
      if (!await finishBrowserSpinIntent(store.current, intent.current.requestId)) throw new Error("Another request exists");
      intent.current = null;
      adopted.current = false;
      setPhase("ready"); setMessage(null);
    } catch {
      if (intent.current) presented.current.delete(intent.current.requestId);
      setPhase("storage"); setMessage(storageMessage());
    }
  }, []);
  return { phase, message, absent: phase === "pending" && absent, locked: phase !== "ready", sending: phase === "sending", check, retry, begin, acknowledge, initialize };
}
