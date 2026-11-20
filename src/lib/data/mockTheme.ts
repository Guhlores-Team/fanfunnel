// Demo (mock) store for per-creator theming, in parity with profiles.theme +
// creator_media (migration 0058). The demo has one creator, so the theme and
// the photo hub are single values pinned to globalThis (like the RM-4 state in
// mock.ts) so pages and route handlers share them. Photos keep the re-encoded
// WebP bytes in memory and are served by /api/demo/creator-media/[id], which
// answers only in demo mode.
import { DEFAULT_THEME, MAX_MEDIA, normalizeTheme, toDbTheme, type CreatorTheme } from "@/lib/creatorTheme/config";

export interface MockMedia {
  id: string;
  webp: Buffer;
  caption: string | null;
  width: number;
  height: number;
  sortOrder: number;
  createdAt: string;
}

const g = globalThis as unknown as { __ffTheme?: Record<string, string>; __ffMedia?: MockMedia[] };
function media(): MockMedia[] {
  return (g.__ffMedia ??= []);
}

export function mockMediaUrl(id: string): string {
  return `/api/demo/creator-media/${id}`;
}

export function mockGetTheme(): CreatorTheme {
  return normalizeTheme(g.__ffTheme ?? {});
}

export function mockListMedia(): MockMedia[] {
  return media()
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

export function mockGetMedia(id: string): MockMedia | null {
  return media().find((m) => m.id === id) ?? null;
}

/** Parity with set_creator_theme: a photo background must be one of the demo creator's photos. */
export function mockSetTheme(theme: CreatorTheme): { theme: CreatorTheme } | { error: "invalid_photo" } {
  if (theme.background === "photo" && !media().some((m) => m.id === theme.bgMediaId)) return { error: "invalid_photo" };
  g.__ffTheme = toDbTheme(theme);
  return { theme: mockGetTheme() };
}

/** Parity with the insert + the 12-photo trigger. */
export function mockAddMedia(m: Omit<MockMedia, "id" | "sortOrder" | "createdAt">): MockMedia | { error: "limit_reached" } {
  const all = media();
  if (all.length >= MAX_MEDIA) return { error: "limit_reached" };
  const row: MockMedia = { ...m, id: crypto.randomUUID(), sortOrder: all.length, createdAt: new Date().toISOString() };
  all.push(row);
  return row;
}

export function mockUpdateCaption(id: string, caption: string | null): boolean {
  const m = mockGetMedia(id);
  if (!m) return false;
  m.caption = caption;
  return true;
}

export function mockReorder(ids: string[]): void {
  ids.forEach((id, i) => {
    const m = mockGetMedia(id);
    if (m) m.sortOrder = i;
  });
}

/** Parity with the delete + the trigger that resets a theme using that photo. */
export function mockDeleteMedia(id: string): boolean {
  const all = media();
  const i = all.findIndex((m) => m.id === id);
  if (i < 0) return false;
  all.splice(i, 1);
  const t = mockGetTheme();
  if (t.bgMediaId === id) g.__ffTheme = toDbTheme({ ...t, background: DEFAULT_THEME.background, bgMediaId: null });
  return true;
}

/** Admin "Remove photos" in demo mode: every photo goes (the theme resets via the delete). */
export function mockRemoveAllMedia(): number {
  const ids = media().map((m) => m.id);
  for (const id of ids) mockDeleteMedia(id);
  return ids.length;
}
