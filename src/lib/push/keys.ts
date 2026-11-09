import "server-only";

// VAPID keys for web push, from the environment. Server-only: the private key
// must never reach a "use client" module or the browser bundle
// (serverOnly.test.ts enforces it). The public key is served at runtime by
// GET /api/push/config, so a new key needs no rebuild.
//
//   VAPID_PUBLIC_KEY   public half (NEXT_PUBLIC_VAPID_PUBLIC_KEY also accepted)
//   VAPID_PRIVATE_KEY  private half, never NEXT_PUBLIC_*
//   VAPID_SUBJECT      mailto:you@yourdomain (or an https: URL)
//
// Any of the three missing or malformed = push is OFF: the routes answer
// "not_configured", the Settings card says it's unavailable, and nothing is
// sent or thrown.

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function vapidKeys(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  const publicKey = (env.VAPID_PUBLIC_KEY || env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY || "").trim();
  const subject = (env.VAPID_SUBJECT || "").trim();
  // P-256: an 87-char public key (65 bytes) and a 43-char private key (32 bytes).
  if (!B64URL.test(publicKey) || publicKey.length !== 87) return null;
  if (!B64URL.test(privateKey) || privateKey.length !== 43) return null;
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/\S+$/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export const isPushConfigured = () => vapidKeys() !== null;

/** The public half only, for the browser's subscribe call. */
export const vapidPublicKey = () => vapidKeys()?.publicKey ?? null;
