import "server-only";
import { createHash } from "node:crypto";
import { isSupabaseConfigured, createClient, createServiceClient } from "@/lib/supabase/server";
import { isActiveAdmin } from "@/lib/auth/adminCheck";
import { alertConfig } from "@/lib/monitoring/alert";
import { currentEnvironment } from "@/lib/monitoring/config";
import { accountMailConfig, brandedEmail, sendAccountEmail, siteOrigin, type AccountMail, type AccountMailConfig } from "@/lib/account/accountMail";
import { runAfterResponse } from "@/lib/afterResponse";
import { creatorGameFeatures } from "./gameSettings";
import { mockListGameUnlockRequests, mockRequestGameUnlock } from "./mock";

// PR-04: scratch tickets and bingo are enabled per creator by an admin. A
// creator asks from the New game dialog; the request is a creator_notices
// row (kind game_unlock_request, 0073 extends the kind CHECK) that the
// admins' bell lists until the feature is on, plus one e-mail to
// ALERT_EMAIL_TO that names nobody. If the row cannot be stored the e-mail
// still goes and the answer says so (recorded: false).

export const UNLOCKABLE_GAMES = ["scratch", "bingo"] as const;
export type UnlockableGame = (typeof UNLOCKABLE_GAMES)[number];
export function isUnlockableGame(value: unknown): value is UnlockableGame {
  return typeof value === "string" && (UNLOCKABLE_GAMES as readonly string[]).includes(value);
}
/** A repeat ask within this window is answered as the earlier one. */
export const UNLOCK_REQUEST_WINDOW_DAYS = 7;

export type GameUnlockOutcome =
  | { ok: true; recorded: boolean; already: boolean }
  | { error: "unauthorized" | "forbidden" | "bad_request" | "already_enabled" | "db_error" };

export interface GameUnlockRequest { id: string; creatorId: string; creatorName: string | null; game: UnlockableGame; at: string }

/** The admin e-mail. Pure: carries no creator data. */
export function buildGameUnlockAlertEmail(origin: string | null, game: UnlockableGame): AccountMail {
  const link = origin ? `${origin}/dashboard?section=admin` : null;
  const label = game === "scratch" ? "scratch tickets" : "bingo";
  return brandedEmail({
    subject: `A creator asked to enable ${label} on FanFunnel`,
    preheader: `Someone wants ${label} switched on for their account.`,
    heading: "Game unlock request",
    paragraphs: [
      `A creator asked for ${label} to be enabled on their account.`,
      link ? "Open Admin, find the account and switch the feature on under Features." : "Open the dashboard › Admin, find the account and switch the feature on under Features.",
    ],
    button: link ? { label: "Open Admin", url: link } : null,
    footnote: "Sent to the addresses in ALERT_EMAIL_TO.",
  });
}

/** E-mail the admins about one request. Never throws. */
export async function sendGameUnlockAlert(
  game: UnlockableGame,
  deps: { cfg?: AccountMailConfig; to?: string[]; send?: (cfg: AccountMailConfig, to: string[], mail: AccountMail) => Promise<boolean>; environment?: string } = {},
): Promise<"sent" | "skipped" | "failed"> {
  try {
    const cfg = deps.cfg ?? accountMailConfig();
    const to = deps.to ?? alertConfig().to;
    if (!cfg.apiKey || to.length === 0 || (deps.environment ?? currentEnvironment()) === "development") return "skipped";
    const send = deps.send ?? sendAccountEmail;
    return (await send(cfg, to, buildGameUnlockAlertEmail(siteOrigin(), game))) ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

type Svc = ReturnType<typeof createServiceClient>;

/**
 * The row id for one creator, game and window. Derived, so two requests that
 * arrive together write the SAME primary key and the database keeps one:
 * the dedupe does not rest on a read that both could pass.
 */
export function unlockRequestId(creatorId: string, game: UnlockableGame, now: number = Date.now()): string {
  const bucket = Math.floor(now / (UNLOCK_REQUEST_WINDOW_DAYS * 86_400_000));
  const hex = createHash("sha256").update(`game_unlock_request:${creatorId}:${game}:${bucket}`).digest("hex");
  // Shaped as a name-based (version 5, RFC 4122 variant) UUID.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Store the request for the admins' bell. "already": an earlier ask in the
 * window (or the same ask arriving twice) holds the row; "refused": the
 * database would not take it.
 */
async function storeGameUnlockRequest(svc: Svc, creatorId: string, game: UnlockableGame): Promise<"stored" | "already" | "refused"> {
  const since = new Date(Date.now() - UNLOCK_REQUEST_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: recent, error: readError } = await svc
    .from("creator_notices")
    .select("id, details")
    .eq("creator_id", creatorId)
    .eq("kind", "game_unlock_request")
    .gte("created_at", since)
    .limit(10);
  if (!readError && (recent ?? []).some((r) => (r as { details?: { game?: unknown } }).details?.game === game)) return "already";
  // INSERT … ON CONFLICT (id) DO NOTHING: the answer lists the row only for
  // the request that actually wrote it.
  const { data: written, error } = await svc
    .from("creator_notices")
    .upsert({ id: unlockRequestId(creatorId, game), creator_id: creatorId, kind: "game_unlock_request", details: { game } }, { onConflict: "id", ignoreDuplicates: true })
    .select("id");
  if (error) {
    // 0073: one OPEN request per creator and game (unique index
    // creator_notices_unlock_request_key). An older request that is still
    // open, outside this window, answers 23505: it is already asked.
    if (error.code === "23505") return "already";
    console.error("requestGameUnlock: could not store the request", { code: error.code });
    return "refused";
  }
  return (written ?? []).length > 0 ? "stored" : "already";
}

export async function requestGameUnlock(game: unknown, deps: { alert?: (game: UnlockableGame) => Promise<unknown> } = {}): Promise<GameUnlockOutcome> {
  if (!isUnlockableGame(game)) return { error: "bad_request" };
  if (!isSupabaseConfigured()) return mockRequestGameUnlock(game);
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  // Only an account in good standing may ask: the session itself proves it
  // (active, approved, second factor satisfied) before the service role is
  // touched or any admin is e-mailed. Anything but a literal true refuses.
  const { data: allowed, error: permissionError } = await sb.rpc("can_act_for", { target_creator: user.id, perm: "manage" });
  if (permissionError || allowed !== true) return { error: "forbidden" };
  const { data: profile, error: profileError } = await sb.from("profiles").select("features").eq("id", user.id).maybeSingle();
  if (profileError) return { error: "db_error" };
  if (creatorGameFeatures((profile as { features?: unknown } | null)?.features)[game] === true) return { error: "already_enabled" };
  const stored = await storeGameUnlockRequest(createServiceClient(), user.id, game);
  if (stored === "already") return { ok: true, recorded: true, already: true };
  const alert = deps.alert ?? sendGameUnlockAlert;
  runAfterResponse(async () => { await alert(game); });
  return { ok: true, recorded: stored === "stored", already: false };
}

/**
 * Open requests for the admins' bell: newest first, without the ones whose
 * game is on by now. Empty for anyone but an active admin, and on any error.
 */
export async function listGameUnlockRequests(sb: Parameters<typeof isActiveAdmin>[0], service?: Svc): Promise<GameUnlockRequest[]> {
  if (!isSupabaseConfigured()) return mockListGameUnlockRequests();
  try {
    if (!(await isActiveAdmin(sb))) return [];
    // The service role is touched only for an admin (RLS hides other
    // creators' notices from a session).
    const svc = service ?? createServiceClient();
    const { data, error } = await svc
      .from("creator_notices")
      .select("id, creator_id, details, created_at")
      .eq("kind", "game_unlock_request")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error || !data) return [];
    const rows = (data as { id: string; creator_id: string; details: { game?: unknown } | null; created_at: string }[]).filter((r) => isUnlockableGame(r.details?.game));
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.creator_id))];
    const { data: profiles } = await svc.from("profiles").select("id, display_name, features").in("id", ids);
    const byId = new Map((profiles ?? []).map((p) => [(p as { id: string }).id, p as { display_name: string | null; features?: unknown }]));
    const seen = new Set<string>();
    return rows.flatMap((r) => {
      const game = r.details!.game as UnlockableGame;
      const key = `${r.creator_id}:${game}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const profile = byId.get(r.creator_id);
      if (profile && creatorGameFeatures(profile.features)[game] === true) return [];
      return [{ id: r.id, creatorId: r.creator_id, creatorName: profile?.display_name ?? null, game, at: r.created_at }];
    });
  } catch {
    return [];
  }
}
