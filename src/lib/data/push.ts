// Data layer — web push devices (migration 0056) for the signed-in creator.
//
// Every read and write goes through the caller's own session client (anon key
// + RLS, where push_subscriptions is own-rows-only and suspended accounts get
// nothing), AND is filtered to `user_id = auth user`. The user id ALWAYS comes
// from auth.getUser(); a user_id (or anything else) in a request body is
// ignored. The only service-client use is the delivery bookkeeping in
// src/lib/push/send.ts (last_success_at / failures, which a creator may not
// write), on rows already resolved for this user.
import { createHash } from "node:crypto";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import {
  DEFAULT_SHOW_DETAILS,
  deviceLabel,
  isAllowedPushEndpoint,
  isPushKey,
  PUSH_MAX_DEVICES,
  PUSH_MAX_FAILURES,
} from "@/lib/push/config";
import { isPushConfigured, vapidPublicKey } from "@/lib/push/keys";
import { testPushPayload } from "@/lib/push/payload";
import { deliverAll } from "@/lib/push/send";
import {
  mockAddPushDevice,
  mockListPushDevices,
  mockRemovePushDevice,
  mockSetPushDeviceDetails,
  type MockPushDevice,
} from "./mockPush";

/** What the Settings card sees about a device. Never the endpoint or keys. */
export interface PushDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  showDetails: boolean;
  /** Stopped after repeated delivery failures; a test or re-subscribe revives it. */
  paused: boolean;
  /** First 16 hex of SHA-256(endpoint), so a browser can spot "this device". */
  endpointHash: string;
}

export type PushError =
  | "unauthorized"
  | "not_configured"
  | "invalid_subscription"
  | "too_many_devices"
  | "conflict"
  | "not_found"
  | "bad_request"
  | "db_error";

const hashEndpoint = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

type Row = {
  id: string;
  endpoint: string;
  show_details: boolean;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  failures: number;
};
const COLS = "id, endpoint, show_details, user_agent, created_at, last_success_at, failures";

const fromRow = (r: Row): PushDevice => ({
  id: r.id,
  label: r.user_agent || "Device",
  createdAt: r.created_at,
  lastSuccessAt: r.last_success_at,
  showDetails: r.show_details === true,
  paused: r.failures >= PUSH_MAX_FAILURES,
  endpointHash: hashEndpoint(r.endpoint),
});

const fromMock = (d: MockPushDevice): PushDevice => ({
  id: d.id,
  label: d.userAgent || "Device",
  createdAt: d.createdAt,
  lastSuccessAt: d.lastSuccessAt,
  showDetails: d.showDetails,
  paused: d.failures >= PUSH_MAX_FAILURES,
  endpointHash: hashEndpoint(d.endpoint),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

async function session() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return user ? { sb, uid: user.id } : null;
}

/** The account a push route acts for (rate-limit key), or null when signed out. Demo: "demo". */
export async function pushAccountId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return "demo";
  return (await session())?.uid ?? null;
}

/** Push availability for the Settings card: the public key when configured. */
export function getPushConfig(): { available: boolean; publicKey: string | null } {
  const publicKey = vapidPublicKey();
  return { available: publicKey !== null, publicKey };
}

export async function listMyPushDevices(): Promise<{ devices: PushDevice[] } | { error: PushError }> {
  if (!isSupabaseConfigured()) return { devices: mockListPushDevices().map(fromMock) };
  const s = await session();
  if (!s) return { error: "unauthorized" };
  const { data, error } = await s.sb
    .from("push_subscriptions")
    .select(COLS)
    .eq("user_id", s.uid)
    .order("created_at", { ascending: true });
  if (error) return { error: "db_error" };
  return { devices: ((data ?? []) as Row[]).map(fromRow) };
}

/** Parse a browser PushSubscription JSON ({endpoint, keys:{p256dh, auth}}). */
export function parseSubscription(input: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  if (!input || typeof input !== "object") return null;
  const sub = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (!isAllowedPushEndpoint(sub.endpoint)) return null;
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (!isPushKey(p256dh, 256) || !isPushKey(auth, 64)) return null;
  return { endpoint: sub.endpoint, p256dh, auth };
}

/**
 * Register this browser for the signed-in creator. A browser already
 * registered to THIS account is refreshed (keys renewed, failures cleared, its
 * lock-screen choice kept). One registered to ANOTHER account is never taken
 * over here: "conflict", and the browser makes a fresh subscription instead.
 */
export async function addMyPushSubscription(
  input: unknown,
  userAgent: string | null
): Promise<{ ok: true; device: PushDevice } | { error: PushError }> {
  if (!isPushConfigured()) return { error: "not_configured" };
  const sub = parseSubscription(input);
  const label = deviceLabel(userAgent);

  if (!isSupabaseConfigured()) {
    if (!sub) return { error: "invalid_subscription" };
    const r = mockAddPushDevice(sub, label);
    return "error" in r ? r : { ok: true, device: fromMock(r.device) };
  }

  const s = await session();
  if (!s) return { error: "unauthorized" };
  if (!sub) return { error: "invalid_subscription" };
  const { sb, uid } = s;

  const { data: mine, error: readErr } = await sb
    .from("push_subscriptions")
    .select("id, endpoint, show_details")
    .eq("user_id", uid);
  if (readErr) return { error: "db_error" };
  const rows = (mine ?? []) as { id: string; endpoint: string; show_details: boolean }[];
  const same = rows.find((r) => r.endpoint === sub.endpoint);
  if (!same && rows.length >= PUSH_MAX_DEVICES) return { error: "too_many_devices" };
  if (same) {
    const { error } = await sb.from("push_subscriptions").delete().eq("id", same.id).eq("user_id", uid);
    if (error) return { error: "db_error" };
  }

  const { data, error } = await sb
    .from("push_subscriptions")
    .insert({
      user_id: uid,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      show_details: same ? same.show_details === true : DEFAULT_SHOW_DETAILS,
      user_agent: label,
    })
    .select(COLS)
    .single();
  if (error) return { error: error.code === "23505" ? "conflict" : "db_error" };
  return { ok: true, device: fromRow(data as Row) };
}

export async function removeMyPushDevice(id: unknown): Promise<{ ok: true } | { error: PushError }> {
  if (!isSupabaseConfigured()) {
    if (typeof id !== "string") return { error: "bad_request" };
    return mockRemovePushDevice(id) ? { ok: true } : { error: "not_found" };
  }
  const s = await session();
  if (!s) return { error: "unauthorized" };
  if (!isId(id)) return { error: "bad_request" };
  const { data, error } = await s.sb
    .from("push_subscriptions")
    .delete()
    .eq("id", id)
    .eq("user_id", s.uid)
    .select("id");
  if (error) return { error: "db_error" };
  return (data ?? []).length > 0 ? { ok: true } : { error: "not_found" };
}

export async function setMyPushDeviceDetails(
  id: unknown,
  showDetails: unknown
): Promise<{ ok: true; device: PushDevice } | { error: PushError }> {
  if (typeof showDetails !== "boolean") return { error: "bad_request" };
  if (!isSupabaseConfigured()) {
    if (typeof id !== "string") return { error: "bad_request" };
    const d = mockSetPushDeviceDetails(id, showDetails);
    return d ? { ok: true, device: fromMock(d) } : { error: "not_found" };
  }
  const s = await session();
  if (!s) return { error: "unauthorized" };
  if (!isId(id)) return { error: "bad_request" };
  const { data, error } = await s.sb
    .from("push_subscriptions")
    .update({ show_details: showDetails })
    .eq("id", id)
    .eq("user_id", s.uid)
    .select(COLS);
  if (error) return { error: "db_error" };
  const row = ((data ?? []) as Row[])[0];
  return row ? { ok: true, device: fromRow(row) } : { error: "not_found" };
}

/**
 * "Send a test" to the signed-in creator's own devices (or one of them). A
 * device that answers 404/410 is removed; a success un-pauses it.
 */
export async function sendMyTestPush(
  deviceId?: unknown
): Promise<{ ok: true; sent: number; removed: number; failed: number } | { error: PushError }> {
  if (!isPushConfigured()) return { error: "not_configured" };
  if (deviceId !== undefined && deviceId !== null && typeof deviceId !== "string") return { error: "bad_request" };

  let uid = "demo";
  let targets: { id: string; endpoint: string; p256dh: string; auth: string }[];
  if (!isSupabaseConfigured()) {
    targets = mockListPushDevices();
  } else {
    const s = await session();
    if (!s) return { error: "unauthorized" };
    uid = s.uid;
    if (deviceId != null && !isId(deviceId)) return { error: "bad_request" };
    const { data, error } = await s.sb
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", uid);
    if (error) return { error: "db_error" };
    targets = (data ?? []) as typeof targets;
  }
  if (deviceId != null) targets = targets.filter((t) => t.id === deviceId);
  if (targets.length === 0) return { error: "not_found" };

  const payload = testPushPayload();
  const r = await deliverAll(
    uid,
    targets.map((t) => ({ ...t, payload }))
  );
  return { ok: true, sent: r.sent, removed: r.removed, failed: r.failed };
}
