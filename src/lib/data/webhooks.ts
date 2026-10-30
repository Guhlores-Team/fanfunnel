// Data layer — creator webhooks (CRUD + fan-out) with the SSRF guard.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import type { Webhook } from "./types";
import { mockListWebhooks, mockCreateWebhook, mockDeleteWebhook, mockFireWebhooks } from "./mock";

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

// --- Webhook SSRF guard -----------------------------------------------------
// Webhooks let a creator POST spin events to an arbitrary URL from our server,
// so block targets that point at internal infrastructure (loopback, RFC1918,
// link-local incl. the 169.254.169.254 cloud-metadata IP, CGNAT, IPv6 local).
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) tunnels an IPv4 target through an
  // IPv6 literal; normalize the embedded IPv4 and apply the IPv4 range checks so
  // these can't bypass the loopback/link-local/RFC1918 guards above.
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && isIP(mapped[1]) === 4) return isPrivateIp(mapped[1]);
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

async function isBlockedWebhookHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (isIP(host)) return isPrivateIp(host);
  try {
    // Resolve ALL records and reject if ANY is private. `fetch` does its own DNS
    // resolution, so checking only the first address lets a host with mixed
    // public/private A-records pass here and then connect to the private one.
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return true;
    return addrs.some(({ address }) => isPrivateIp(address));
  } catch {
    return true; // unresolvable host → treat as unsafe
  }
}

export async function createWebhook(
  url: string,
  event = "prize_pending"
): Promise<Webhook | { error: string }> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return { error: "invalid_url" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "invalid_url" };
  }
  if (await isBlockedWebhookHost(parsed.hostname)) return { error: "blocked_url" };
  if (!isSupabaseConfigured()) return mockCreateWebhook(trimmed, event);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data, error } = await sb
    .from("webhooks")
    .insert({ creator_id: user.id, url: trimmed, event })
    .select("id, url, event, created_at")
    .single();
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

/**
 * Best-effort fan-out: POST `payload` as JSON to each of the creator's webhooks,
 * swallowing every error so a slow/failing endpoint can't break a spin. No-op in
 * demo mode.
 */
export async function fireWebhooks(
  creatorId: string,
  payload: object
): Promise<void> {
  if (!isSupabaseConfigured()) return mockFireWebhooks(creatorId, payload);

  try {
    const sb = createServiceClient();
    const { data } = await sb
      .from("webhooks")
      .select("url")
      .eq("creator_id", creatorId);
    const hooks = (data ?? []) as { url: string }[];
    const body = JSON.stringify(payload);
    const deliver = async (h: { url: string }) => {
      // Re-validate at fire time too (guards against a host that has since
      // been re-pointed at an internal IP via DNS).
      let parsed: URL;
      try {
        parsed = new URL(h.url);
      } catch {
        return;
      }
      if (await isBlockedWebhookHost(parsed.hostname)) return;
      // `redirect: "manual"` is critical: without it `fetch` would follow a
      // 3xx from an allowed public host to an internal target (e.g. the cloud
      // metadata IP 169.254.169.254), defeating the SSRF host check above.
      const res = await fetch(h.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "manual",
        // Cap how long a single endpoint can hold a socket open — without this
        // a slow-loris webhook could pin server sockets indefinitely (the
        // fan-out is fire-and-forget, so nothing else reaps it).
        signal: AbortSignal.timeout(5000),
      });
      // A redirected response means the endpoint tried to bounce us elsewhere;
      // drop it rather than chase the Location to a possibly-internal host.
      if (res.status >= 300 && res.status < 400) return;
    };
    // Cap concurrency so a creator with many (slow) webhooks can't open an
    // unbounded number of sockets at once.
    const CONCURRENCY = 5;
    for (let i = 0; i < hooks.length; i += CONCURRENCY) {
      await Promise.allSettled(hooks.slice(i, i + CONCURRENCY).map(deliver));
    }
  } catch {
    /* never throws */
  }
}
