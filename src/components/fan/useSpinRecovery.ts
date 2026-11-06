"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpinResult } from "@/lib/games/wheel/types";
import { spinErrorInfo } from "../spinErrors";
import { browserSpinIntentStore, classifySpinStatus, finishBrowserSpinIntent, persistBrowserSpinIntent, readBrowserSpinIntent,
  spinIntentBody, SPIN_RECOVERY_COPY, type BrowserSpinIntent, type SpinIntentStore } from "./spinIntent";


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
export function useSpinRecovery({ token, canRetry, onCommitted, onRefusal, validateResult }: {
  token: string;
  canRetry: boolean;
  onCommitted: (result: SpinResult, options: { present: boolean; recovered: boolean }) => void;
  onRefusal: (code: unknown) => void;
  validateResult?: (result: unknown) => boolean;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "sending" | "pending" | "revealing" | "storage">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const store = useRef<SpinIntentStore | null>(null);
  const intent = useRef<BrowserSpinIntent | null>(null);
  const running = useRef(false);
  const presented = useRef(new Set<string>());
  const handlers = useRef({ canRetry, onCommitted, onRefusal, validateResult });
  useEffect(() => { handlers.current = { canRetry, onCommitted, onRefusal, validateResult }; }, [canRetry, onCommitted, onRefusal, validateResult]);

  const apply = useCallback((data: SpinResult, id: string, recovered: boolean) => {
    if (data?.attemptId !== id || !data.prize || !Number.isInteger(data.prizeIndex)
      || !Number.isSafeInteger(data.spinsRemaining) || data.spinsRemaining < 0) throw new Error("Unconfirmed response");
    if (handlers.current.validateResult && !handlers.current.validateResult(data)) throw new Error("Unconfirmed game presentation");
    const present = !presented.current.has(id);
    handlers.current.onCommitted(data, { present, recovered: recovered || data.replayed === true });
    presented.current.add(id);
    setPhase("revealing");
    setMessage(null);
  }, []);

  const check = useCallback(async () => {
    if (running.current || !intent.current) return;
    running.current = true;
    const saved = intent.current;
    try {
      const { response, data } = await postIntent("/api/spin/status", token, saved);
      const outcome = classifySpinStatus(data, response.ok);
      if (outcome.kind === "committed") apply(outcome.result as SpinResult, saved.requestId, true);
      else if (outcome.kind === "declined" && store.current) {
        const cleared = await finishBrowserSpinIntent(store.current, saved.requestId);
        if (!cleared) throw new Error("Another saved request exists");
        intent.current = null;
        setPhase("ready");
        setMessage(spinErrorInfo(outcome.error).message);
        handlers.current.onRefusal(outcome.error);
      } else {
        setPhase("pending");
        setMessage(outcome.kind === "keep" ? outcome.message : SPIN_RECOVERY_COPY.unavailable);
        if (data.error) handlers.current.onRefusal(data.error);
      }
    } catch {
      setPhase("pending");
      setMessage(SPIN_RECOVERY_COPY.unavailable);
    } finally { running.current = false; }
  }, [apply, token]);

  const initialize = useCallback(async () => {
    if (running.current) return;
    try {
      const nextStore = await browserSpinIntentStore(token);
      const saved = readBrowserSpinIntent(nextStore);
      store.current = nextStore;
      if (saved) {
        intent.current = saved;
        setPhase("pending");
        setMessage(SPIN_RECOVERY_COPY.pending);
        await check();
      } else if (!intent.current) { setPhase("ready"); setMessage(null); }
    } catch { setPhase("storage"); setMessage(SPIN_RECOVERY_COPY.storage); }
  }, [check, token]);

  useEffect(() => {
    const boot = setTimeout(() => void initialize(), 0);
    const resume = () => {
      if (document.visibilityState !== "hidden") {
        if (intent.current) void check(); else void initialize();
      }
    };
    const changed = (event: StorageEvent) => { if (event.key === store.current?.key) resume(); };
    window.addEventListener("online", resume);
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearTimeout(boot);
      window.removeEventListener("online", resume);
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [check, initialize]);

  const send = useCallback(async (saved: BrowserSpinIntent) => {
    if (running.current || !handlers.current.canRetry) return;
    running.current = true;
    setPhase("sending");
    setMessage(null);
    try {
      const { response, data } = await postIntent("/api/spin", token, saved);
      if (response.ok) apply(data, saved.requestId, false);
      else {
        handlers.current.onRefusal(data.error);
        setPhase("pending");
        setMessage(spinErrorInfo(data.error).message + " Check this spin before playing again.");
      }
    } catch { setPhase("pending"); setMessage(SPIN_RECOVERY_COPY.pending); }
    finally { running.current = false; }
  }, [apply, token]);

  const begin = useCallback(async (clientSeed: string, publishedSeedHash: string | null) => {
    if (running.current || !handlers.current.canRetry || !store.current) return;
    // The ref closes the same-tab double-tap gap before React updates.
    if (intent.current) { await check(); return; }
    running.current = true;
    setPhase("sending");
    let saved: BrowserSpinIntent;
    try {
      saved = await persistBrowserSpinIntent(store.current, { v: 1, requestId: crypto.randomUUID(), clientSeed,
        ...(publishedSeedHash ? { publishedSeedHash } : {}) });
      intent.current = saved;
    } catch {
      setPhase("storage"); setMessage(SPIN_RECOVERY_COPY.storage);
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
      setPhase("ready"); setMessage(null);
    } catch {
      if (intent.current) presented.current.delete(intent.current.requestId);
      setPhase("storage"); setMessage(SPIN_RECOVERY_COPY.storage);
    }
  }, []);
  return { phase, message, locked: phase !== "ready", sending: phase === "sending", check, retry, begin, acknowledge, initialize };
}
