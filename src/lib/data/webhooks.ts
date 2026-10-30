// Data layer — creator webhooks (CRUD + fan-out) with the SSRF guard.
//
// A16: each hook gets only the event it subscribed to ('all' = every win), a
// creator may hold at most WEBHOOK_LIMIT hooks (also a 0064 trigger), every
// delivery is signed with the creator's own secret (X-FanFunnel-Signature,
// HMAC-SHA256; the secret lives in webhook_secrets, which only the server can
// read), and the target address is resolved once, checked, and pinned for the
// connection so a DNS rebind can't redirect it to an internal address.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { rateLimitShared } from "@/lib/rateLimit";
import type { Webhook } from "./types";
import { mockListWebhooks, mockCreateWebhook, mockDeleteWebhook, mockFireWebhooks } from "./mock";
import { resolveWebhookTarget, type WebhookTarget } from "./webhookGuard";

/** Events a hook can subscribe to; 'all' receives every win. */
export const WEBHOOK_EVENTS = ["all", "prize_pending", "prize_delivered"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v);
}
/** Most hooks per creator (the 0064 webhooks_cap trigger enforces the same). */
export const WEBHOOK_LIMIT = 5;
/** Deliveries per creator per minute, across instances when Upstash is set. */
export const WEBHOOK_DELIVERIES_PER_MINUTE = 120;
/** Whole-request budget for one delivery (connect + send + response head). */
export const WEBHOOK_TIMEOUT_MS = 5000;

// --- Webhooks (#24) ---------------------------------------------------------

/** The creator's registered outbound webhooks (newest first, RLS-scoped). */
export async function listWebhooks(): Promise<Webhook[]> {
  if (!isSupabaseConfigured()) return mockListWebhooks();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("webhooks")
    .select("id, url, event, created_at")
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as {
    id: string;
    url: string;
    event: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    event: r.event,
    createdAt: r.created_at,
  }));
}

export async function createWebhook(
  url: string,
  event: string = "all"
): Promise<Webhook | { error: string }> {
  if (!isWebhookEvent(event)) return { error: "invalid_event" };
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return { error: "invalid_url" };
  const target = await resolveWebhookTarget(trimmed);
  if (!target.ok) return { error: target.reason };
  if (!isSupabaseConfigured()) {
    if (mockListWebhooks().length >= WEBHOOK_LIMIT) return { error: "webhook_limit" };
    return mockCreateWebhook(trimmed, event);
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { count } = await sb
    .from("webhooks")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", user.id);
  if ((count ?? 0) >= WEBHOOK_LIMIT) return { error: "webhook_limit" };

  const { data, error } = await sb
    .from("webhooks")
    .insert({ creator_id: user.id, url: trimmed, event })
    .select("id, url, event, created_at")
    .single();
  // 23514 = the cap trigger (a racing insert) or the event check.
  if (error?.code === "23514") return { error: "webhook_limit" };
  if (error || !data) return { error: "db_error" };
  return {
    id: data.id,
    url: data.url,
    event: data.event,
    createdAt: data.created_at,
  };
}

export async function deleteWebhook(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteWebhook(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("webhooks")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

// --- Signing secret -----------------------------------------------------------

const g = globalThis as unknown as { __ffMockWebhookSecret?: string };
const newSecret = () => randomBytes(32).toString("hex");

/**
 * The signed-in creator's webhook signing secret, created on first use; with
 * `rotate`, a fresh one replaces it. Authorization is explicit: the session's
 * own can_act_for(user, 'manage') (false for a suspended account), then the
 * service role reads/writes webhook_secrets, which no API role can touch.
 */
export async function getWebhookSecret(
  opts: { rotate?: boolean } = {},
): Promise<{ secret: string } | { error: "unauthorized" | "forbidden" | "db_error" }> {
  if (!isSupabaseConfigured()) {
    if (opts.rotate || !g.__ffMockWebhookSecret) g.__ffMockWebhookSecret = newSecret();
    return { secret: g.__ffMockWebhookSecret };
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data: allowed, error: denied } = await sb.rpc("can_act_for", { target_creator: user.id, perm: "manage" });
  if (denied || allowed !== true) return { error: "forbidden" };

  const svc = createServiceClient();
  if (opts.rotate) {
    const { error } = await svc
      .from("webhook_secrets")
      .upsert({ creator_id: user.id, secret: newSecret(), rotated_at: new Date().toISOString() }, { onConflict: "creator_id" });
    if (error) return { error: "db_error" };
  }
  const secret = await readOrCreateSecret(svc, user.id);
  return secret ? { secret } : { error: "db_error" };
}

type ServiceClient = ReturnType<typeof createServiceClient>;
async function readOrCreateSecret(svc: ServiceClient, creatorId: string): Promise<string | null> {
  const read = async () => {
    const { data, error } = await svc.from("webhook_secrets").select("secret").eq("creator_id", creatorId).maybeSingle();
    return error ? undefined : ((data as { secret: string } | null)?.secret ?? null);
  };
  const existing = await read();
  if (existing !== null) return existing ?? null;
  // First use: insert unless a racing request already did, then re-read.
  await svc.from("webhook_secrets").upsert({ creator_id: creatorId, secret: newSecret() }, { onConflict: "creator_id", ignoreDuplicates: true });
  return (await read()) ?? null;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (receiver docs in Boosts). */
export function webhookSignature(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

// --- Delivery -------------------------------------------------------------------

/**
 * POST once to an already-vetted target, connecting ONLY to `target.ip`.
 * A hostname goes through node:http(s) with a lookup pinned to that address
 * (TLS still verifies the certificate for the hostname); an IP-literal URL has
 * nothing to resolve and uses fetch. Redirects are never followed. Resolves
 * the HTTP status, or 0 on any failure/timeout.
 */
export async function postPinned(
  target: Extract<WebhookTarget, { ok: true }>,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number = WEBHOOK_TIMEOUT_MS,
): Promise<number> {
  const { url, ip, family } = target;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === ip) {
    try {
      const res = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      void res.body?.cancel().catch(() => {});
      return res.status;
    } catch {
      return 0;
    }
  }
  return new Promise<number>((resolve) => {
    let settled = false;
    const done = (status: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        // Pinned: whatever the name resolves to now, connect to the vetted IP.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family)) as never,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume(); // discard the body; only the status matters
        done(res.statusCode ?? 0);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(0);
    }, timeoutMs);
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(0));
    req.end(body);
  });
}

/**
 * Best-effort fan-out: POST `payload` as signed JSON to each of the creator's
 * webhooks subscribed to its event, swallowing every error so a slow/failing
 * endpoint can't break a spin. No-op in demo mode.
 */
export async function fireWebhooks(
  creatorId: string,
  payload: { event: string } & Record<string, unknown>
): Promise<void> {
  if (!isSupabaseConfigured()) return mockFireWebhooks(creatorId, payload);

  try {
    if (!(await rateLimitShared(`webhooks:deliver:${creatorId}`, WEBHOOK_DELIVERIES_PER_MINUTE, 60_000)).ok) return;
    const sb = createServiceClient();
    const { data } = await sb
      .from("webhooks")
      .select("url")
      .eq("creator_id", creatorId)
      .in("event", [payload.event, "all"])
      .limit(WEBHOOK_LIMIT);
    const hooks = (data ?? []) as { url: string }[];
    if (!hooks.length) return;
    // No secret readable → the delivery goes out unsigned (receivers that
    // verify will drop it); a spin never waits on or fails for a webhook.
    const secret = await readOrCreateSecret(sb, creatorId).catch(() => null);
    const deliveryId = randomUUID();
    const body = JSON.stringify({ ...payload, id: deliveryId });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "FanFunnel-Webhooks/1",
      "X-FanFunnel-Event": payload.event,
      "X-FanFunnel-Delivery": deliveryId,
      ...(secret ? { "X-FanFunnel-Signature": webhookSignature(secret, body, timestamp) } : {}),
    };
    await Promise.allSettled(
      hooks.map(async (h) => {
        // Re-validate at fire time (the name may now point somewhere else),
        // then connect only to the address that was just checked.
        const target = await resolveWebhookTarget(h.url);
        if (!target.ok) return;
        await postPinned(target, headers, body);
      }),
    );
  } catch {
    /* never throws */
  }
}
