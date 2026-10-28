"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { timeAgo } from "@/lib/format";
import { DEFAULT_SHOW_DETAILS, needsHomeScreenInstall } from "@/lib/push/config";
import {
  applicationServerKey,
  currentPushSubscription,
  dashboardRegistration,
  endpointHash,
  isStandalone,
  pushSupported,
} from "@/lib/push/browser";

// Settings › Notifications › Push to this device (web push). Mounted with one
// line from SettingsPanel, under the notification toggles; styles match its
// cards. Everything server-side goes through /api/push/* as the signed-in
// creator: their own devices only.

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const secondaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-line px-4 text-sm font-semibold text-ink transition-colors hover:border-[var(--brand)]/60 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";

interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  showDetails: boolean;
  paused: boolean;
  endpointHash: string;
}

/** Why push can't be turned on here (null = it can). */
type Blocker = "loading" | "unsupported" | "ios_install" | "unavailable" | "denied" | null;

const PHONE = "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM11 18h2";

function Switch({
  on,
  disabled,
  onToggle,
  label,
  hint,
  testId,
}: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      data-testid={testId}
      className="flex w-full items-center justify-between gap-4 py-3 text-left transition-colors hover:bg-white/[0.02] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={`relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors ${on ? "bg-[var(--brand)]" : "bg-line"}`}
      >
        <span
          className={`absolute top-[3px] h-5 w-5 rounded-full transition-transform ${
            on ? "translate-x-[23px] bg-[var(--brand-ink)]" : "translate-x-[3px] bg-white"
          }`}
        />
      </span>
    </button>
  );
}

export default function PushNotificationsCard({ focusNonce = 0 }: { focusNonce?: number }) {
  const toast = useToast();
  const titleId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<Blocker>("loading");
  const [devices, setDevices] = useState<Device[]>([]);
  const [hereHash, setHereHash] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "toggle" | "details" | "test" | string>(null);

  const here = hereHash ? (devices.find((d) => d.endpointHash === hereHash) ?? null) : null;

  const loadDevices = useCallback(async () => {
    try {
      const res = await fetch("/api/push/subscribe", { cache: "no-store" });
      if (res.ok) setDevices(((await res.json()).devices ?? []) as Device[]);
    } catch {
      /* keep the last list */
    }
  }, []);

  const refreshHere = useCallback(async () => {
    const sub = await currentPushSubscription();
    setHereHash(sub ? await endpointHash(sub.endpoint) : null);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      let available = false;
      try {
        const res = await fetch("/api/push/config", { cache: "no-store" });
        const cfg = res.ok ? await res.json() : null;
        available = !!cfg?.available && typeof cfg.publicKey === "string";
        if (live && available) setPublicKey(cfg.publicKey);
      } catch {
        /* treated as unavailable */
      }
      await loadDevices();
      if (!live) return;
      const nav = navigator as Navigator & { maxTouchPoints?: number };
      if (needsHomeScreenInstall(nav.userAgent, isStandalone(), nav.maxTouchPoints ?? 0)) setBlocker("ios_install");
      else if (!pushSupported()) setBlocker("unsupported");
      else if (!available) setBlocker("unavailable");
      else if (Notification.permission === "denied") setBlocker("denied");
      else setBlocker(null);
      if (pushSupported()) await refreshHere();
    })();
    return () => {
      live = false;
    };
  }, [loadDevices, refreshHere]);

  // Deep link from the bell footer / Inbox: bring this card into view.
  useEffect(() => {
    if (!focusNonce) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    cardRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, [focusNonce]);

  async function register(reg: ServiceWorkerRegistration, key: string): Promise<Response> {
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) });
    return fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  }

  async function turnOn() {
    if (!publicKey) return;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      if (perm === "denied") setBlocker("denied");
      toast("Notifications weren't allowed in this browser.", { tone: "error" });
      return;
    }
    const reg = await dashboardRegistration();
    if (!reg) throw new Error("no service worker");
    let res = await register(reg, publicKey);
    if (res.status === 409) {
      // This browser is still registered to another account: start a fresh
      // subscription (a new endpoint) instead of taking that one over.
      await (await reg.pushManager.getSubscription())?.unsubscribe();
      res = await register(reg, publicKey);
    }
    if (!res.ok) {
      await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => {});
      const code = (await res.json().catch(() => null))?.error;
      throw new Error(code === "too_many_devices" ? "too_many_devices" : "subscribe_failed");
    }
    toast("Push is on for this device.", { tone: "success" });
  }

  async function turnOff() {
    const sub = await currentPushSubscription();
    if (here) await remove(here.id, { quiet: true });
    await sub?.unsubscribe().catch(() => false);
    toast("Push is off for this device.", { tone: "success" });
  }

  async function toggle() {
    setBusy("toggle");
    try {
      if (here) await turnOff();
      else await turnOn();
    } catch (e) {
      toast(
        e instanceof Error && e.message === "too_many_devices"
          ? "You have too many devices. Remove one below first."
          : "Couldn't change push for this device.",
        { tone: "error" }
      );
    } finally {
      await Promise.all([loadDevices(), refreshHere()]);
      setBusy(null);
    }
  }

  async function setDetails(next: boolean) {
    if (!here) return;
    setBusy("details");
    try {
      const res = await fetch("/api/push/subscribe", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: here.id, showDetails: next }),
      });
      if (!res.ok) throw new Error();
      setDevices((list) => list.map((d) => (d.id === here.id ? { ...d, showDetails: next } : d)));
    } catch {
      toast("Couldn't save the lock-screen setting.", { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!here) return;
    setBusy("test");
    try {
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: here.id }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 429) toast("Too many tests. Try again in a minute.", { tone: "error" });
      else if (!res.ok) toast("Couldn't send a test.", { tone: "error" });
      else if (data?.sent > 0) toast("Test sent. Check your notifications.", { tone: "success" });
      else if (data?.removed > 0) toast("This device stopped accepting push. Turn it on again.", { tone: "error" });
      else toast("The test didn't go through. Try again shortly.", { tone: "error" });
    } finally {
      await Promise.all([loadDevices(), refreshHere()]);
      setBusy(null);
    }
  }

  async function remove(id: string, { quiet = false } = {}) {
    setBusy((b) => b ?? id);
    try {
      const res = await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok && res.status !== 404) throw new Error();
      if (id === here?.id && !quiet) await (await currentPushSubscription())?.unsubscribe().catch(() => false);
      setDevices((list) => list.filter((d) => d.id !== id));
      if (!quiet) toast("Device removed.", { tone: "success" });
    } catch {
      if (!quiet) toast("Couldn't remove that device.", { tone: "error" });
    } finally {
      if (!quiet) {
        await refreshHere();
        setBusy(null);
      }
    }
  }

  const ready = blocker === null;
  const showDetails = here?.showDetails ?? DEFAULT_SHOW_DETAILS;

  return (
    <section
      ref={cardRef}
      id="push-notifications"
      aria-labelledby={titleId}
      data-testid="push-card"
      className={`min-w-0 scroll-mt-24 space-y-4 rounded-2xl p-5 ${raised}`}
    >
      <div>
        <h3
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-[15px] font-bold text-ink focus:outline-none"
        >
          <span className="text-brand">
            <svg
              width={17}
              height={17}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
              className="shrink-0"
            >
              <path d={PHONE} />
            </svg>
          </span>
          Phone &amp; desktop alerts
        </h3>
        <p className="mt-1 text-xs text-muted">
          Get the bell&rsquo;s alerts as notifications, even when FanFunnel is closed. Turn it on for each device.
        </p>
      </div>

      <p
        role="status"
        data-testid="push-status"
        className={`text-[13px] ${blocker === "ios_install" ? "font-semibold text-ink" : "text-muted"}`}
      >
        {blocker === "loading" && "Checking this device…"}
        {blocker === "unavailable" && "Push notifications aren’t available on this site yet."}
        {blocker === "unsupported" &&
          "This browser can’t receive push notifications. Try Chrome, Edge, Firefox or Safari, or the installed app on your phone."}
        {blocker === "denied" &&
          "Notifications are blocked for FanFunnel in this browser. Allow them in the site settings, then come back."}
        {blocker === "ios_install" && "Add FanFunnel to your Home Screen first."}
        {ready && (here ? (here.paused ? "On, but paused: deliveries kept failing. Send a test to wake it." : "On for this device.") : "Off for this device.")}
      </p>

      {blocker === "ios_install" && (
        <ol
          data-testid="push-ios-steps"
          className="list-decimal space-y-1 rounded-xl border border-[var(--hair)] [background:var(--s2)] py-3 pl-8 pr-4 text-[13px] text-ink"
        >
          <li>In Safari, tap the Share button.</li>
          <li>Choose &ldquo;Add to Home Screen&rdquo;, then Add.</li>
          <li>Open FanFunnel from your Home Screen and turn this on there (iOS 16.4 or later).</li>
        </ol>
      )}

      <div className="flex flex-col">
        <div className="border-b border-[var(--hair)]">
          <Switch
            testId="push-toggle"
            on={!!here}
            disabled={!ready || busy !== null}
            onToggle={toggle}
            label="Push to this device"
            hint="Wins to fulfil, new messages, low prize stock and fans out of spins, as you’ve chosen above."
          />
        </div>
        <Switch
          testId="push-details-toggle"
          on={showDetails}
          disabled={!ready || !here || busy !== null}
          onToggle={() => setDetails(!showDetails)}
          label="Show names and prizes on lock screen"
          hint={
            showDetails
              ? "This device shows who and what, e.g. “Nova won 👑 VIP Month”."
              : "Off: this device just says “New activity on FanFunnel”."
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={sendTest}
          disabled={!ready || !here || busy !== null}
          data-testid="push-test"
          className={secondaryBtn}
        >
          {busy === "test" ? "Sending…" : "Send a test"}
        </button>
      </div>

      {devices.length > 0 && (
        <div>
          <h4 className="text-[13px] font-semibold text-ink">Devices with push</h4>
          <ul className="mt-2 flex flex-col divide-y divide-[var(--hair)]" aria-label="Devices with push">
            {devices.map((d) => (
              <li key={d.id} data-testid="push-device" className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block break-words text-sm font-semibold text-ink">
                    {d.label}
                    {d.id === here?.id && <span className="font-normal text-muted"> (this device)</span>}
                  </span>
                  <span className="block text-xs text-muted">
                    Added {timeAgo(d.createdAt)} · {d.showDetails ? "Names shown" : "Generic"}
                    {d.paused ? " · Paused" : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => remove(d.id)}
                  disabled={busy !== null}
                  aria-label={`Remove ${d.label}${d.id === here?.id ? " (this device)" : ""}`}
                  className={`${secondaryBtn} shrink-0`}
                >
                  {busy === d.id ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
