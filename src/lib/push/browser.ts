// Browser-side web push helpers (Settings card + Inbox). No server imports.
import { SERVICE_WORKER_SCOPE } from "@/lib/pwa/config";

/** This browser can do web push at all (secure context + the three APIs). */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Running as the installed home-screen app. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true;
}

/** The dashboard's service worker registration (registered by AppServiceWorker). */
export async function dashboardRegistration(timeoutMs = 8000): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE).catch(() => undefined);
  if (existing?.active) return existing;
  return Promise.race([
    navigator.serviceWorker.ready.then((r) => r).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
}

/** This browser's push subscription for the dashboard, if any. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE).catch(() => undefined);
  if (!reg) return null;
  return reg.pushManager.getSubscription().catch(() => null);
}

/** First 16 hex of SHA-256(endpoint): matches PushDevice.endpointHash. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** VAPID public key (base64url) → the bytes PushManager.subscribe wants. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
