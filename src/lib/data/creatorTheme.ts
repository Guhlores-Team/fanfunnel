// Data layer — per-creator theming (migration 0058): the headline font and
// background (profiles.theme) and the photo hub (creator_media + the
// `creator-media` bucket).
//
// Authorization:
//   * The fan page and /c/<slug> read a creator's theme with the service
//     client, server-side, keyed by the creator id the page already resolved
//     (like getFanPass / getPublicProfileBySlug); nothing private is returned.
//   * The creator's own reads and writes use the SESSION client: the theme is
//     written only through set_creator_theme (own active row, allow-list, own
//     photo), and caption / order / delete go through creator_media's RLS and
//     column grants. No function here takes a creator id from the request, so
//     a creator can never touch another creator's look or photos.
//   * Inserting a photo row and writing / removing storage objects use the
//     service client, only after this module has resolved the signed-in user,
//     checked the account is active, and re-encoded the file (processImage).
//   * Admin removal runs only behind requireAdminRoute (is_admin()), and the
//     row delete still goes through RLS (creator_media_delete allows is_admin()).
import { randomUUID } from "node:crypto";
import { checkAdmin } from "@/lib/auth/adminCheck";
import { abandonStorageUpload, processMediaRemoval, queueMediaRemoval, storageRpc, trackedCreatorUpload } from "@/lib/storage/work";
import { isSupabaseConfigured, createClient, createServiceClient } from "@/lib/supabase/server";
import {
  DEFAULT_THEME,
  MAX_MEDIA,
  MEDIA_BUCKET,
  PHOTO_HUB_ENABLED,
  REQUIRE_SFW_ATTESTATION,
  isMediaId,
  isMediaPath,
  normalizeCaption,
  normalizeTheme,
  parseThemeInput,
  toDbTheme,
  type CreatorTheme,
  type ThemeMedia,
} from "@/lib/creatorTheme/config";
import { processUpload } from "@/lib/creatorTheme/processImage";
import { mockGetAdminOverview } from "./mock";
import {
  mockAddMedia,
  mockDeleteMedia,
  mockGetTheme,
  mockListMedia,
  mockMediaUrl,
  mockRemoveAllMedia,
  mockReorder,
  mockSetTheme,
  mockUpdateCaption,
} from "./mockTheme";

export type { ThemeMedia };

/** What a themed page renders: the keys, the gallery, and the background photo. */
export interface CreatorThemeView {
  theme: CreatorTheme;
  media: ThemeMedia[];
  /** The background photo's URL (theme.background === "photo"), else null. */
  bgUrl: string | null;
}

export const DEFAULT_THEME_VIEW: CreatorThemeView = { theme: DEFAULT_THEME, media: [], bgUrl: null };

type MediaRow = { id: string; path: string; caption: string | null; width: number; height: number };
const MEDIA_COLS = "id, path, caption, width, height";

// getPublicUrl only formats a URL (no request, no key involved).
type StorageClient = { storage: ReturnType<typeof createServiceClient>["storage"] };
function publicUrl(sb: StorageClient, path: string): string {
  return sb.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Combine the stored keys and photos into what a page renders. */
function toView(rawTheme: unknown, media: ThemeMedia[]): CreatorThemeView {
  let theme = normalizeTheme(rawTheme);
  const bg = theme.background === "photo" ? media.find((m) => m.id === theme.bgMediaId) : undefined;
  // A background photo that no longer exists (or the hub switched off) reads
  // as the default background; the DB trigger resets it too.
  if (theme.background === "photo" && !bg) theme = { ...theme, background: DEFAULT_THEME.background, bgMediaId: null };
  return { theme, media: PHOTO_HUB_ENABLED ? media : [], bgUrl: bg?.url ?? null };
}

function mockView(): CreatorThemeView {
  const media = mockListMedia().map((m) => ({ id: m.id, url: mockMediaUrl(m.id), caption: m.caption, width: m.width, height: m.height }));
  return toView(toDbTheme(mockGetTheme()), media);
}

/**
 * A creator's theme for the fan page and /c/<slug>. Service role, read-only;
 * any failure (including a database without 0058) serves the default look.
 */
export async function getCreatorThemeView(creatorId: string | null | undefined): Promise<CreatorThemeView> {
  if (!isSupabaseConfigured()) return mockView();
  if (!creatorId) return DEFAULT_THEME_VIEW;
  try {
    const sb = createServiceClient();
    const [prof, rows] = await Promise.all([
      sb.from("profiles").select("theme").eq("id", creatorId).maybeSingle(),
      PHOTO_HUB_ENABLED
        ? sb
            .from("creator_media")
            .select(MEDIA_COLS)
            .eq("creator_id", creatorId)
            .order("sort_order", { ascending: true })
            .order("created_at", { ascending: true })
            .limit(MAX_MEDIA)
        : Promise.resolve({ data: [] as MediaRow[], error: null }),
    ]);
    if (prof.error) return DEFAULT_THEME_VIEW;
    const media = ((rows.error ? [] : rows.data) as MediaRow[])
      .filter((r) => isMediaPath(r.path) && r.path.startsWith(`${creatorId}/`))
      .map((r) => ({ id: r.id, url: publicUrl(sb, r.path), caption: r.caption, width: r.width, height: r.height }));
    return toView((prof.data as { theme?: unknown } | null)?.theme, media);
  } catch (err) {
    console.error("getCreatorThemeView failed", err);
    return DEFAULT_THEME_VIEW;
  }
}

export interface MyThemeView extends CreatorThemeView {
  photosEnabled: boolean;
  sfwRequired: boolean;
  maxMedia: number;
}

type Session = { sb: Awaited<ReturnType<typeof createClient>>; userId: string };
async function session(): Promise<Session | null> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return user ? { sb, userId: user.id } : null;
}

async function activeSession(s: Session): Promise<boolean> {
  try {
    const result = await s.sb.rpc("current_user_active");
    return !result.error && result.data === true;
  } catch {
    return false;
  }
}

const extras = { photosEnabled: PHOTO_HUB_ENABLED, sfwRequired: REQUIRE_SFW_ATTESTATION, maxMedia: MAX_MEDIA };

/** The signed-in creator's own theme and photos (session client, RLS). */
export async function getMyTheme(): Promise<MyThemeView | { error: "unauthorized" }> {
  if (!isSupabaseConfigured()) return { ...mockView(), ...extras };
  const s = await session();
  if (!s) return { error: "unauthorized" };
  const [prof, rows] = await Promise.all([
    s.sb.from("profiles").select("theme").eq("id", s.userId).maybeSingle(),
    s.sb
      .from("creator_media")
      .select(MEDIA_COLS)
      .eq("creator_id", s.userId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);
  const media = ((rows.error ? [] : rows.data) as MediaRow[])
    .filter((r) => isMediaPath(r.path))
    .map((r) => ({ id: r.id, url: publicUrl(s.sb, r.path), caption: r.caption, width: r.width, height: r.height }));
  return { ...toView(prof.error ? {} : (prof.data as { theme?: unknown } | null)?.theme, media), ...extras };
}

export type SetThemeError = "unauthorized" | "forbidden" | "invalid_font" | "invalid_background" | "invalid_photo" | "photos_disabled" | "db_error";

/**
 * Save the signed-in creator's own font + background. There is no target
 * argument: set_creator_theme writes auth.uid()'s row only and accepts a
 * background photo only from that creator's own media.
 */
export async function setMyTheme(raw: unknown): Promise<{ ok: true; theme: CreatorTheme } | { error: SetThemeError }> {
  const parsed = parseThemeInput(raw);
  if ("error" in parsed) return parsed;
  if (!isSupabaseConfigured()) {
    const r = mockSetTheme(parsed.theme);
    return "error" in r ? r : { ok: true, theme: r.theme };
  }
  const s = await session();
  if (!s) return { error: "unauthorized" };
  const { data, error } = await s.sb.rpc("set_creator_theme", { p_theme: toDbTheme(parsed.theme) });
  if (error) {
    if (/invalid theme photo/.test(error.message)) return { error: "invalid_photo" };
    if (/invalid theme/.test(error.message)) return { error: "invalid_background" };
    return { error: "db_error" };
  }
  // null: no active row was updated (a suspended account).
  if (data == null) return { error: "forbidden" };
  return { ok: true, theme: normalizeTheme(data) };
}

export type AddMediaError =
  | "unauthorized"
  | "forbidden"
  | "photos_disabled"
  | "sfw_required"
  | "limit_reached"
  | "no_file"
  | "too_large"
  | "not_image"
  | "upload_failed"
  | "storage_cleanup_failed"
  | "storage_cleanup_pending"
  | "db_error";

/**
 * Add a photo to the signed-in creator's hub. The file is re-encoded (no
 * metadata, WebP, <= 1600px) before anything is stored; the object goes to a
 * random path in the creator's own folder; the row is inserted by the server.
 */
export async function addMyMedia(input: {
  bytes: Uint8Array;
  caption?: unknown;
  sfwAttested?: unknown;
}): Promise<{ ok: true; media: ThemeMedia } | { error: AddMediaError }> {
  if (!PHOTO_HUB_ENABLED) return { error: "photos_disabled" };
  if (REQUIRE_SFW_ATTESTATION && input.sfwAttested !== true) return { error: "sfw_required" };
  const caption = normalizeCaption(input.caption);

  if (!isSupabaseConfigured()) {
    if (mockListMedia().length >= MAX_MEDIA) return { error: "limit_reached" };
    const img = await processUpload(input.bytes);
    if ("error" in img) return img;
    const row = mockAddMedia({ webp: img.webp, caption, width: img.width, height: img.height });
    if ("error" in row) return row;
    return { ok: true, media: { id: row.id, url: mockMediaUrl(row.id), caption, width: row.width, height: row.height } };
  }

  const s = await session();
  if (!s) return { error: "unauthorized" };
  if (!(await activeSession(s))) return { error: "forbidden" };
  const { count } = await s.sb
    .from("creator_media")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", s.userId);
  if ((count ?? 0) >= MAX_MEDIA) return { error: "limit_reached" };

  const img = await processUpload(input.bytes);
  if ("error" in img) return img;

  const path = `${s.userId}/${randomUUID()}.webp`;
  const svc = createServiceClient();
  const up = await trackedCreatorUpload(svc, {
    owner: s.userId, bucket: MEDIA_BUCKET, path, bytes: img.webp, contentType: "image/webp", cacheControl: "31536000",
    authorize: () => activeSession(s), publish: false,
  });
  if ("error" in up) return up;

  const committed = await storageRpc(svc, "creator_storage_publish_media", {
    p_id: up.id, p_caption: caption, p_width: img.width, p_height: img.height, p_sort_order: count ?? 0,
  });
  // A lost acknowledgement may conceal a committed row. Keep that exact
  // intent recoverable; never abandon independently from its metadata.
  if (committed.error || !committed.data) return { error: "storage_cleanup_pending" };
  if (!(await activeSession(s))) return { error: await abandonStorageUpload(svc, up.id) ? "forbidden" : "storage_cleanup_failed" };
  const data = committed.data;
  const row = data as MediaRow;
  return { ok: true, media: { id: row.id, url: publicUrl(svc, row.path), caption: row.caption, width: row.width, height: row.height } };
}

/** Re-caption one of the signed-in creator's own photos (RLS + column grant). */
export async function setMyMediaCaption(id: unknown, caption: unknown): Promise<{ ok: true } | { error: "unauthorized" | "not_found" | "db_error" }> {
  if (!isMediaId(id)) return { error: "not_found" };
  const text = normalizeCaption(caption);
  if (!isSupabaseConfigured()) return mockUpdateCaption(id, text) ? { ok: true } : { error: "not_found" };
  const s = await session();
  if (!s) return { error: "unauthorized" };
  const { data, error } = await s.sb
    .from("creator_media")
    .update({ caption: text })
    .eq("id", id)
    .eq("creator_id", s.userId)
    .select("id");
  if (error) return { error: "db_error" };
  return (data?.length ?? 0) === 1 ? { ok: true } : { error: "not_found" };
}

/** Re-order the signed-in creator's photos; ids that aren't theirs change nothing. */
export async function reorderMyMedia(ids: unknown): Promise<{ ok: true } | { error: "unauthorized" | "bad_request" | "db_error" }> {
  if (!Array.isArray(ids) || ids.length > MAX_MEDIA || !ids.every(isMediaId) || new Set(ids).size !== ids.length) {
    return { error: "bad_request" };
  }
  if (!isSupabaseConfigured()) {
    mockReorder(ids);
    return { ok: true };
  }
  const s = await session();
  if (!s) return { error: "unauthorized" };
  const results = await Promise.all(
    ids.map((id, i) => s.sb.from("creator_media").update({ sort_order: i }).eq("id", id).eq("creator_id", s.userId))
  );
  return results.some((r) => r.error) ? { error: "db_error" } : { ok: true };
}

/** Remove the stored object first, retaining its row if storage fails. */
export async function deleteMyMedia(id: unknown): Promise<{ ok: true } | { error: "unauthorized" | "forbidden" | "not_found" | "db_error" | "storage_cleanup_failed" }> {
  if (!isMediaId(id)) return { error: "not_found" };
  if (!isSupabaseConfigured()) return mockDeleteMedia(id) ? { ok: true } : { error: "not_found" };
  const s = await session();
  if (!s) return { error: "unauthorized" };
  if (!(await activeSession(s))) return { error: "forbidden" };
  const { data, error } = await s.sb
    .from("creator_media")
    .select("id, path")
    .eq("id", id)
    .eq("creator_id", s.userId);
  if (error) return { error: "db_error" };
  if (data?.length !== 1) return { error: "not_found" };
  const path = (data[0] as { path: string }).path;
  if (!isMediaPath(path)) {
    return { error: "storage_cleanup_failed" };
  }
  const svc = createServiceClient();
  if (!(await queueMediaRemoval(svc, s.userId, [{ id, path }], s.userId))) return { error: "db_error" };
  const removed = await processMediaRemoval(svc, s.userId, [path]);
  if ("error" in removed) return removed;
  return { ok: true };
}

/**
 * Admin moderation ("Remove photos" on an account row): authorize again with
 * is_admin(), read scoped rows through RLS, remove those objects, then delete
 * only those rows. Storage failures preserve every row and retry path.
 */
export async function adminRemoveCreatorMedia(creatorId: unknown): Promise<{ ok: true; removed: number; auditRecorded?: boolean } | { error: "unauthorized" | "forbidden" | "bad_request" | "not_found" | "db_error" | "storage_cleanup_failed" }> {
  if (!isSupabaseConfigured()) {
    if (typeof creatorId !== "string" || !creatorId) return { error: "bad_request" };
    if (!mockGetAdminOverview().accounts.some((account) => account.id === creatorId)) return { error: "not_found" };
    // The demo dashboard/public hub belongs to acc-you. Other seeded/demo
    // accounts have no media, and never grant access to this creator's photos.
    return { ok: true, removed: creatorId === "acc-you" ? mockRemoveAllMedia() : 0 };
  }
  if (!isMediaId(creatorId)) return { error: "bad_request" };
  const sb = await createClient();
  const access = await checkAdmin(sb);
  if (access.status === "anonymous") return { error: "unauthorized" };
  if (access.status !== "admin") return { error: "forbidden" };
  const { data, error } = await sb.from("creator_media").select("id, path").eq("creator_id", creatorId);
  if (error) return { error: "db_error" };
  const rows = (data ?? []) as { id: string; path: string }[];
  if (rows.length > MAX_MEDIA) return { error: "db_error" };
  if (rows.length === 0) return { ok: true, removed: 0 };
  if (!rows.every((row) => isMediaId(row.id) && isMediaPath(row.path) && row.path.startsWith(`${creatorId}/`))) {
    return { error: "storage_cleanup_failed" };
  }
  const svc = createServiceClient();
  if (!(await queueMediaRemoval(svc, creatorId, rows, access.userId, true))) return { error: "db_error" };
  const removed = await processMediaRemoval(svc, creatorId, rows.map((row) => row.path));
  if ("error" in removed) return removed;
  return { ok: true, removed: rows.length, auditRecorded: true };
}
