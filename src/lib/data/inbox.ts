// Data layer — inbox: DM templates, fan <-> creator chat threads and the
// auto intro / outro messages.
import { demoActingCreator, resolveActingCreator } from "./seatScope";
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import type { DmTemplate, ChatMessage, ChatSettings, FanThread } from "./types";
import {
  mockListDmTemplates,
  mockCreateDmTemplate,
  mockDeleteDmTemplate,
  mockSendFanMessage,
  mockGetFanMessages,
  mockListThreads,
  mockGetThread,
  mockSendCreatorMessage,
  mockGetChatSettings,
  mockSetChatSettings,
  mockEnsureChatIntro,
  mockSendChatOutro,
  mockFanIdForToken,
} from "./mock";
import { resolveFanByToken } from "./fans";
import { runAfterResponse } from "@/lib/afterResponse";
import { notifyCreator } from "@/lib/push/notify";

// ---------------------------------------------------------------------------
// DM templates: a creator's saved, reusable direct-message snippets. `{link}`
// is a placeholder the UI swaps for a fan's full spin URL. Creator-scoped (RLS).
// ---------------------------------------------------------------------------

export async function listDmTemplates(): Promise<DmTemplate[]> {
  if (!isSupabaseConfigured()) return mockListDmTemplates();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("dm_templates")
    .select("id, title, body, created_at")
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as {
    id: string;
    title: string;
    body: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function createDmTemplate(
  title: string,
  body: string
): Promise<{ template: DmTemplate } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return { template: mockCreateDmTemplate(title, body) };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data, error } = await sb
    .from("dm_templates")
    .insert({ creator_id: user.id, title, body })
    .select("id, title, body, created_at")
    .single();
  if (error || !data) return { error: "db_error" };

  return {
    template: {
      id: data.id,
      title: data.title,
      body: data.body,
      createdAt: data.created_at,
    },
  };
}

export async function deleteDmTemplate(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockDeleteDmTemplate(id) ? { ok: true } : { error: "not_found" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("dm_templates")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

// --- Chat (spin-gated; messages are FREE) -----------------------------------

function toChatMessage(r: {
  id: string;
  sender: "fan" | "creator";
  body: string;
  created_at: string;
  read_at: string | null;
}): ChatMessage {
  return {
    id: r.id,
    sender: r.sender,
    body: r.body,
    at: r.created_at,
    readAt: r.read_at,
  };
}

const MESSAGE_SELECT = "id, sender, body, created_at, read_at";

export async function sendFanMessage(
  token: string,
  body: string
): Promise<{ ok: true } | { error: "not_found" | "blocked" | "locked" | "empty" | "db_error" }> {
  if (!isSupabaseConfigured()) {
    const res = mockSendFanMessage(token, body);
    if ("ok" in res) {
      const fanId = mockFanIdForToken(token);
      if (fanId) runAfterResponse(() => notifyCreator("demo", { type: "message", fanId }));
      return res;
    }
    // The mock may use its own validation code ("invalid_body"); normalize any
    // unknown error to the contract's "empty".
    const known = ["not_found", "blocked", "locked", "empty", "db_error"] as const;
    type Known = (typeof known)[number];
    const code = (known as readonly string[]).includes(res.error)
      ? (res.error as Known)
      : "empty";
    return { error: code };
  }

  const sb = createServiceClient();
  const { data: passData } = await sb
    .from("fan_passes")
    .select("creator_id, fan:fans(id, spins_remaining, spins_granted_total, blocked_at)")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = passData as unknown as {
    creator_id: string;
    fan: {
      id: string;
      spins_remaining: number;
      spins_granted_total: number;
      blocked_at?: string | null;
    } | null;
  } | null;
  if (!pass || !pass.fan) return { error: "not_found" };
  // A4: a fan the creator blocked can no longer message them.
  if (pass.fan.blocked_at) return { error: "blocked" };

  // GATE: chat unlocks while the fan holds spins OR has ever been granted any.
  if (!(pass.fan.spins_remaining > 0 || pass.fan.spins_granted_total > 0))
    return { error: "locked" };

  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 2000) return { error: "empty" };

  const { error } = await sb.from("messages").insert({
    creator_id: pass.creator_id,
    fan_id: pass.fan.id,
    sender: "fan",
    body: trimmed,
  });
  if (error) return { error: "db_error" };
  // Web push to the creator's devices after the response (F7); the creator id
  // is the server-side pass row's.
  const creatorId = pass.creator_id;
  const fanId = pass.fan.id;
  runAfterResponse(() => notifyCreator(creatorId, { type: "message", fanId }));
  return { ok: true };
}

export async function getFanMessages(token: string): Promise<ChatMessage[]> {
  if (!isSupabaseConfigured()) return mockGetFanMessages(token);

  const sb = createServiceClient();
  const { data: passData } = await sb
    .from("fan_passes")
    .select("creator_id, fan_id")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = passData as { creator_id: string; fan_id: string } | null;
  if (!pass) return [];

  const { data } = await sb
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("creator_id", pass.creator_id)
    .eq("fan_id", pass.fan_id)
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as Parameters<typeof toChatMessage>[0][];

  // Mark creator→fan messages as read by the fan — but ONLY when there is
  // actually something unread. The fan chat polls this endpoint, so an
  // unconditional UPDATE on every GET turned every read into a write (the bulk
  // of the messages-table write load). The rows we just fetched carry read_at,
  // so we can skip the write entirely on the common "nothing new" poll.
  const hasUnreadFromCreator = rows.some(
    (r) => r.sender === "creator" && r.read_at === null
  );
  if (hasUnreadFromCreator) {
    await sb
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("creator_id", pass.creator_id)
      .eq("fan_id", pass.fan_id)
      .eq("sender", "creator")
      .is("read_at", null);
  }

  return rows.map(toChatMessage);
}

/** Conversations per Inbox page (the RPC's maximum). */
export const THREAD_PAGE_SIZE = 100;

export interface ThreadPage {
  threads: FanThread[];
  /** Cursor for the next (older) page; null on the last one. */
  next: string | null;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** "<lastAt>|<fanId>": the position of the last thread a caller holds. */
export function decodeThreadCursor(raw: string | null | undefined): { at: string; fanId: string } | null {
  if (!raw) return null;
  const i = raw.lastIndexOf("|");
  if (i <= 0) return null;
  const at = raw.slice(0, i);
  const fanId = raw.slice(i + 1);
  if (!SAFE_ID.test(fanId) || at.length > 40 || Number.isNaN(Date.parse(at))) return null;
  return { at, fanId };
}
const threadCursor = (t: FanThread) => `${t.lastAt}|${t.fanId}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The creator's inbox: one row per fan (latest message + unread count), newest
 * activity first, a page at a time (A13). The Supabase path asks the database
 * for exactly that (creator_inbox_threads, 0064, SECURITY INVOKER so RLS
 * applies) instead of reading every message, so old and unread threads never
 * fall off the end of a capped read.
 */
export async function listThreads(
  before?: string | null,
  limit: number = THREAD_PAGE_SIZE,
  creatorId?: unknown,
): Promise<ThreadPage | { error: "bad_request" | "forbidden" }> {
  const size = Math.min(Math.max(1, limit), THREAD_PAGE_SIZE);
  const cursor = decodeThreadCursor(before);
  if (before && !cursor) return { error: "bad_request" };

  if (!isSupabaseConfigured()) {
    const refused = demoActingCreator(creatorId);
    if (refused) return refused;
    const all = mockListThreads().sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.fanId.localeCompare(a.fanId));
    const rows = cursor
      ? all.filter((t) => t.lastAt < cursor.at || (t.lastAt === cursor.at && t.fanId < cursor.fanId))
      : all;
    const threads = rows.slice(0, size);
    return { threads, next: rows.length > size ? threadCursor(threads[threads.length - 1]) : null };
  }

  if (cursor && !UUID_RE.test(cursor.fanId)) return { error: "bad_request" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { threads: [], next: null };
  // A19: a seat reads another creator's inbox only with can_act_for 'chat'.
  const acting = await resolveActingCreator(sb, user.id, creatorId, "chat");
  if ("error" in acting) return acting;

  // One look-ahead row says whether an older page exists.
  const { data } = await sb.rpc("creator_inbox_threads", {
    p_before_at: cursor?.at,
    p_before_fan: cursor?.fanId,
    p_limit: size + 1,
    ...(acting.creatorId !== user.id ? { p_creator: acting.creatorId } : {}),
  });
  const rows = ((data ?? []) as {
    fan_id: string;
    fan_name: string;
    last_body: string;
    last_at: string;
    unread: number;
  }[]).map((r) => ({
    fanId: r.fan_id,
    fanName: r.fan_name || "Fan",
    lastBody: r.last_body,
    lastAt: r.last_at,
    unread: r.unread ?? 0,
  }));
  const threads = rows.slice(0, size);
  return { threads, next: rows.length > size ? threadCursor(threads[threads.length - 1]) : null };
}

/** Whether the creator has any conversation with this fan (Fans drawer). */
export async function hasThreadWith(fanId: string): Promise<boolean> {
  if (!isSupabaseConfigured()) return mockListThreads().some((t) => t.fanId === fanId);
  if (!UUID_RE.test(fanId)) return false;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return false;
  const { count } = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", user.id)
    .eq("fan_id", fanId);
  return (count ?? 0) > 0;
}

export async function getThread(fanId: string, creatorId?: unknown): Promise<ChatMessage[] | { error: "bad_request" | "forbidden" }> {
  if (!isSupabaseConfigured()) return demoActingCreator(creatorId) ?? mockGetThread(fanId);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];
  // A19: reading (and marking read) another creator's thread needs 'chat'.
  const acting = await resolveActingCreator(sb, user.id, creatorId, "chat");
  if ("error" in acting) return acting;
  const owner = acting.creatorId;

  // Bound the read: fetch the most recent messages (newest-first + limit), then
  // present oldest-first. An unbounded thread read grows without limit as a
  // conversation ages; the UI only needs recent history.
  const { data } = await sb
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("creator_id", owner)
    .eq("fan_id", fanId)
    .order("created_at", { ascending: false })
    .limit(500);
  const rows = ((data ?? []) as Parameters<typeof toChatMessage>[0][])
    .slice()
    .reverse();

  // Mark fan→creator messages as read by the creator.
  await sb
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("creator_id", owner)
    .eq("fan_id", fanId)
    .eq("sender", "fan")
    .is("read_at", null);

  return rows.map(toChatMessage);
}

export async function sendCreatorMessage(
  fanId: string,
  body: string,
  creatorId?: unknown,
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return demoActingCreator(creatorId) ?? mockSendCreatorMessage(fanId, body);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  // A19: replying for another creator needs can_act_for 'chat' (RLS checks it too).
  const acting = await resolveActingCreator(sb, user.id, creatorId, "chat");
  if ("error" in acting) return acting;
  const owner = acting.creatorId;

  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 2000) return { error: "empty" };

  // Confirm the fan belongs to this creator before tagging a message to them.
  // RLS only checks `creator_id`, so without this a creator could create rows
  // referencing an arbitrary fan UUID.
  const { data: ownFan } = await sb
    .from("fans")
    .select("id")
    .eq("id", fanId)
    .eq("creator_id", owner)
    .maybeSingle();
  if (!ownFan) return { error: "not_found" };

  const { error } = await sb.from("messages").insert({
    creator_id: owner,
    fan_id: fanId,
    sender: "creator",
    body: trimmed,
  });
  return error ? { error: "db_error" } : { ok: true };
}

// --- Wave 3: editable auto intro/outro --------------------------------------

/** The creator's editable auto greeting + out-of-spins messages (authed/RLS). */
export async function getChatSettings(): Promise<ChatSettings> {
  if (!isSupabaseConfigured()) return mockGetChatSettings();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { intro: null, outro: null };

  const { data } = await sb
    .from("profiles")
    .select("chat_intro, chat_outro")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as { chat_intro: string | null; chat_outro: string | null } | null;
  return { intro: row?.chat_intro ?? null, outro: row?.chat_outro ?? null };
}

/** Update the creator's auto greeting + out-of-spins messages (authed/RLS). */
export async function setChatSettings(input: {
  intro?: string | null;
  outro?: string | null;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetChatSettings(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // These auto-send verbatim to fans, so cap them like DM templates (2000).
  const CHAT_MSG_MAX = 2000;
  if ((input.intro ?? "").trim().length > CHAT_MSG_MAX) return { error: "too_long" };
  if ((input.outro ?? "").trim().length > CHAT_MSG_MAX) return { error: "too_long" };
  if (input.intro === undefined && input.outro === undefined) return { ok: true };

  // A direct profiles update silently no-ops here (profiles_update RLS is
  // admin-only), so go through the SECURITY DEFINER self-update RPC. When one
  // field is omitted from the patch, carry the current value through.
  let intro = input.intro;
  let outro = input.outro;
  if (intro === undefined || outro === undefined) {
    const current = await getChatSettings();
    if (intro === undefined) intro = current.intro;
    if (outro === undefined) outro = current.outro;
  }
  const { error } = await sb.rpc("set_chat_settings", {
    p_intro: intro ?? "",
    p_outro: outro ?? "",
  });
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Auto-send the creator's greeting when a fan first opens chat (service role:
 * fans aren't authed). Inserts the intro as a `creator` message only if the
 * creator has a non-empty chat_intro AND the thread has ZERO messages.
 * Idempotent: a no-op once any message exists.
 */
export async function ensureChatIntro(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockEnsureChatIntro(token);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };
  if (resolved.blocked) return { error: "blocked" };

  const { data: profile } = await sb
    .from("profiles")
    .select("chat_intro")
    .eq("id", resolved.creatorId)
    .maybeSingle();
  const intro = ((profile as { chat_intro: string | null } | null)?.chat_intro ?? "").trim();
  if (!intro) return { ok: true };

  const { count } = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", resolved.creatorId)
    .eq("fan_id", resolved.fanId);
  if ((count ?? 0) > 0) return { ok: true };

  const { error } = await sb.from("messages").insert({
    creator_id: resolved.creatorId,
    fan_id: resolved.fanId,
    sender: "creator",
    body: intro,
  });
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Auto-send the creator's out-of-spins nudge (service role). Inserts the outro
 * as a `creator` message only if the creator has a non-empty chat_outro AND the
 * most-recent message isn't already that exact outro (guards against spamming).
 */
export async function sendChatOutro(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSendChatOutro(token);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };
  if (resolved.blocked) return { error: "blocked" };

  const { data: profile } = await sb
    .from("profiles")
    .select("chat_outro")
    .eq("id", resolved.creatorId)
    .maybeSingle();
  const outro = ((profile as { chat_outro: string | null } | null)?.chat_outro ?? "").trim();
  if (!outro) return { ok: true };

  const { data: lastRow } = await sb
    .from("messages")
    .select("sender, body")
    .eq("creator_id", resolved.creatorId)
    .eq("fan_id", resolved.fanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = lastRow as { sender: "fan" | "creator"; body: string } | null;
  if (last && last.sender === "creator" && last.body === outro) return { ok: true };

  const { error } = await sb.from("messages").insert({
    creator_id: resolved.creatorId,
    fan_id: resolved.fanId,
    sender: "creator",
    body: outro,
  });
  return error ? { error: "db_error" } : { ok: true };
}
