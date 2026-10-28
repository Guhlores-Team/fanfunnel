// Data layer — inbox: DM templates, fan <-> creator chat threads and the
// auto intro / outro messages.
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
): Promise<{ ok: true } | { error: "not_found" | "locked" | "empty" | "db_error" }> {
  if (!isSupabaseConfigured()) {
    const res = mockSendFanMessage(token, body);
    if ("ok" in res) {
      const fanId = mockFanIdForToken(token);
      if (fanId) runAfterResponse(() => notifyCreator("demo", { type: "message", fanId }));
      return res;
    }
    // The mock may use its own validation code ("invalid_body"); normalize any
    // unknown error to the contract's "empty".
    const known = ["not_found", "locked", "empty", "db_error"] as const;
    type Known = (typeof known)[number];
    const code = (known as readonly string[]).includes(res.error)
      ? (res.error as Known)
      : "empty";
    return { error: code };
  }

  const sb = createServiceClient();
  const { data: passData } = await sb
    .from("fan_passes")
    .select("creator_id, fan:fans(id, spins_remaining, spins_granted_total)")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = passData as unknown as {
    creator_id: string;
    fan: {
      id: string;
      spins_remaining: number;
      spins_granted_total: number;
    } | null;
  } | null;
  if (!pass || !pass.fan) return { error: "not_found" };

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

/** The creator's inbox: one row per fan, newest activity first (authed/RLS). */
export async function listThreads(): Promise<FanThread[]> {
  if (!isSupabaseConfigured()) return mockListThreads();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("messages")
    .select(
      "fan_id, sender, body, read_at, created_at, fan:fans(display_name, handle)"
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as unknown as {
    fan_id: string;
    sender: "fan" | "creator";
    body: string;
    read_at: string | null;
    created_at: string;
    fan: { display_name: string | null; handle: string | null } | null;
  }[];

  const threads = new Map<string, FanThread>();
  for (const r of rows) {
    // Rows are newest-first, so the FIRST row per fan is the latest message.
    let t = threads.get(r.fan_id);
    if (!t) {
      t = {
        fanId: r.fan_id,
        fanName: r.fan?.display_name ?? r.fan?.handle ?? "Fan",
        lastBody: r.body,
        lastAt: r.created_at,
        unread: 0,
      };
      threads.set(r.fan_id, t);
    }
    if (r.sender === "fan" && r.read_at === null) t.unread += 1;
  }
  return [...threads.values()];
}

export async function getThread(fanId: string): Promise<ChatMessage[]> {
  if (!isSupabaseConfigured()) return mockGetThread(fanId);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  // Bound the read: fetch the most recent messages (newest-first + limit), then
  // present oldest-first. An unbounded thread read grows without limit as a
  // conversation ages; the UI only needs recent history.
  const { data } = await sb
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("creator_id", user.id)
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
    .eq("creator_id", user.id)
    .eq("fan_id", fanId)
    .eq("sender", "fan")
    .is("read_at", null);

  return rows.map(toChatMessage);
}

export async function sendCreatorMessage(
  fanId: string,
  body: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSendCreatorMessage(fanId, body);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 2000) return { error: "empty" };

  // Confirm the fan belongs to this creator before tagging a message to them.
  // RLS only checks `creator_id`, so without this a creator could create rows
  // referencing an arbitrary fan UUID.
  const { data: ownFan } = await sb
    .from("fans")
    .select("id")
    .eq("id", fanId)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!ownFan) return { error: "not_found" };

  const { error } = await sb.from("messages").insert({
    creator_id: user.id,
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
