// Demo (no Supabase) store for web push: the demo account's devices, the send
// log and a simulated push service. Parity with push_subscriptions / push_log
// (migration 0056). Pinned to globalThis like the main mock store so pages and
// route handlers share it.
//
// The demo never contacts a real push service: deliveries are recorded in an
// outbox (GET /api/push/outbox, demo only) so e2e can check what WOULD have
// been sent. An endpoint whose path contains "/e2e-gone" answers 410, like a
// browser that unsubscribed, so pruning can be exercised end to end.
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_SHOW_DETAILS, PUSH_MAX_DEVICES, PUSH_MAX_FAILURES } from "@/lib/push/config";
import type { PushPayload } from "@/lib/push/payload";

export interface MockPushDevice {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  showDetails: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failures: number;
}

export interface MockOutboxEntry {
  at: string;
  deviceId: string;
  payload: PushPayload;
  status: number;
}

interface PushStore {
  devices: MockPushDevice[];
  log: Map<string, { tag: string; sentAt: number }>;
  outbox: MockOutboxEntry[];
}

const g = globalThis as unknown as { __ffPushStore?: PushStore };
const store: PushStore = (g.__ffPushStore ??= { devices: [], log: new Map(), outbox: [] });

export const endpointHash = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

export function mockListPushDevices(): MockPushDevice[] {
  return structuredClone(store.devices);
}

export function mockAddPushDevice(
  sub: { endpoint: string; p256dh: string; auth: string },
  userAgent: string | null
): { ok: true; device: MockPushDevice } | { error: "too_many_devices" } {
  const existing = store.devices.find((d) => d.endpoint === sub.endpoint);
  if (existing) {
    // Re-subscribing the same browser refreshes its keys and clears failures.
    Object.assign(existing, { p256dh: sub.p256dh, auth: sub.auth, failures: 0, userAgent });
    return { ok: true, device: structuredClone(existing) };
  }
  if (store.devices.length >= PUSH_MAX_DEVICES) return { error: "too_many_devices" };
  const device: MockPushDevice = {
    id: randomUUID(),
    ...sub,
    showDetails: DEFAULT_SHOW_DETAILS,
    userAgent,
    createdAt: new Date().toISOString(),
    lastSuccessAt: null,
    failures: 0,
  };
  store.devices.push(device);
  return { ok: true, device: structuredClone(device) };
}

export function mockRemovePushDevice(id: string): boolean {
  const before = store.devices.length;
  store.devices = store.devices.filter((d) => d.id !== id);
  return store.devices.length < before;
}

export function mockSetPushDeviceDetails(id: string, showDetails: boolean): MockPushDevice | null {
  const d = store.devices.find((x) => x.id === id);
  if (!d) return null;
  d.showDetails = showDetails;
  return structuredClone(d);
}

/** Devices that still get pushes (not paused after repeated failures). */
export const mockActivePushDevices = () =>
  structuredClone(store.devices.filter((d) => d.failures < PUSH_MAX_FAILURES));

export function mockRecordPushOutcome(id: string, outcome: "ok" | "gone" | "failed"): void {
  if (outcome === "gone") {
    mockRemovePushDevice(id);
    return;
  }
  const d = store.devices.find((x) => x.id === id);
  if (!d) return;
  if (outcome === "ok") {
    d.failures = 0;
    d.lastSuccessAt = new Date().toISOString();
  } else d.failures += 1;
}

/** Claim a send-log key; false when it was already sent (dedupe). */
export function mockClaimPushLog(itemKey: string, tag: string): boolean {
  if (store.log.has(itemKey)) return false;
  store.log.set(itemKey, { tag, sentAt: Date.now() });
  return true;
}

export function mockPushedTagSince(tag: string, sinceMs: number): boolean {
  for (const v of store.log.values()) if (v.tag === tag && v.sentAt >= sinceMs) return true;
  return false;
}

/** The simulated push service: record the delivery and answer like one. */
export function mockDeliverPush(device: { id: string; endpoint: string }, payload: PushPayload): number {
  const status = new URL(device.endpoint).pathname.includes("/e2e-gone") ? 410 : 201;
  store.outbox.unshift({ at: new Date().toISOString(), deviceId: device.id, payload: structuredClone(payload), status });
  store.outbox.length = Math.min(store.outbox.length, 50);
  return status;
}

export function mockPushOutbox(): MockOutboxEntry[] {
  return structuredClone(store.outbox);
}
