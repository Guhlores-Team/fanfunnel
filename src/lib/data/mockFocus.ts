import "server-only";
import type { FocusRow } from "./focusView";
import type { SpinResult } from "@/lib/games/wheel/types";
import type { SpinError } from "./shared";

export interface MockFocus extends FocusRow {
  id: string; fan_id: string; fan_pass_id: string; wheel_id: string;
  kind: "focus" | "chase"; multiplier: number; total_spins: number; spins_left: number;
  chase_counter: number; status: "active" | "paused" | "completed" | "cancelled";
  reservation: { kind: "stock" | "code" | "unlimited"; codeId?: string; held: boolean } | null;
}
interface Attempt { token: string; fanId: string; hash: string; createdAt?: string; finishedAt?: string; result?: SpinResult | SpinError }
interface State {
  focuses: Map<string, MockFocus>; attempts: Map<string, Attempt>;
  grants: Map<string, { hash: string; focus: MockFocus; balance: number; grantId: string }>;
  queues: Map<string, Promise<unknown>>;
  chaseEnabled: boolean;
  passRequests: Map<string, { hash: string; passId?: string; fanId?: string; erased?: boolean }>;
  topupRequests: Map<string, { hash: string; fanId?: string; erased?: boolean }>;
  anonymousWins: Map<string, import("./mock").MockWin>;
  imports: Map<string, { hash: string; items: import("@/lib/imports/batch").ImportBatchItem[] }>;
}
const globalFocus = globalThis as unknown as { __ffFocus?: State };
export function mockFocusState(): State {
  return globalFocus.__ffFocus ??= { focuses: new Map(), attempts: new Map(), grants: new Map(), queues: new Map(), chaseEnabled: false, passRequests: new Map(), topupRequests: new Map(), anonymousWins: new Map(), imports: new Map() };
}
/** Serialize every await from the context read through one synchronous mock commit. */
export async function withMockFanLock<T>(fanId: string, fn: () => Promise<T>): Promise<T> {
  const state = mockFocusState();
  const previous = state.queues.get(fanId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  state.queues.set(fanId, next);
  try { return await next; }
  finally { if (state.queues.get(fanId) === next) state.queues.delete(fanId); }
}
export function eraseMockFocusIdentity(fanId: string): void {
  const state = mockFocusState();
  state.focuses.delete(fanId);
  for (const [id, request] of state.passRequests ?? []) if (request.fanId === fanId) state.passRequests.set(id, { hash: request.hash, erased: true });
  for (const [id, request] of state.topupRequests ?? []) if (request.fanId === fanId) state.topupRequests.set(id, { hash: request.hash, erased: true });
  for (const batch of state.imports?.values() ?? []) for (const item of batch.items) if (item.fanId === fanId) {
    item.error = "gone"; delete item.fanId; delete item.passId; delete item.grantId; delete item.token;
  }
  for (const [id, attempt] of state.attempts) if (attempt.fanId === fanId) state.attempts.delete(id);
  for (const [id, grant] of state.grants) if (grant.focus.fan_id === fanId) state.grants.delete(id);
}
export function clearMockFocusState(): void {
  const state = mockFocusState();
  state.focuses.clear(); state.attempts.clear(); state.grants.clear(); state.chaseEnabled = false; state.passRequests?.clear(); state.topupRequests?.clear(); state.anonymousWins?.clear(); state.imports?.clear();
}
