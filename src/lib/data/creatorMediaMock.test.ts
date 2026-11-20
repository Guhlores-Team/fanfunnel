import assert from "node:assert/strict";
import { mock } from "node:test";
import { DEFAULT_THEME } from "@/lib/creatorTheme/config";
import { mockGetAdminOverview } from "./mock";
import { mockAddMedia, mockGetTheme, mockListMedia, mockRemoveAllMedia, mockSetTheme } from "./mockTheme";

mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => false,
  createClient: async () => { throw new Error("demo must not build a session client"); },
  createServiceClient: () => { throw new Error("demo must not build a service client"); },
} });

async function main() {
  const { adminRemoveCreatorMedia, getMyTheme, getCreatorThemeView } = await import("./creatorTheme");
  mockRemoveAllMedia();
  const media = mockAddMedia({ webp: Buffer.from("fixture"), caption: null, width: 1, height: 1 });
  assert.ok(!("error" in media));
  mockSetTheme({ ...DEFAULT_THEME, background: "photo", bgMediaId: media.id });
  const own = await getMyTheme();
  assert.ok(!("error" in own));
  assert.deepEqual(own.theme, { ...DEFAULT_THEME, background: "photo", bgMediaId: media.id }, "reading a saved photo keeps its ID and background rather than silently selecting Glow");
  assert.equal(own.bgUrl, `/api/demo/creator-media/${media.id}`);
  assert.deepEqual((await getCreatorThemeView("acc-you")).theme, own.theme, "public/fan mock reads agree with the creator's saved appearance");
  assert.equal((await getCreatorThemeView("acc-you")).bgUrl, own.bgUrl);
  for (const account of mockGetAdminOverview().accounts.filter((entry) => entry.id !== "acc-you")) {
    assert.deepEqual(await adminRemoveCreatorMedia(account.id), { ok: true, removed: 0 });
    assert.equal(mockListMedia().length, 1);
  }
  for (const unknown of ["acc-unknown", "aaaaaaaa-0000-4000-8000-00000000000a", "../../acc-you"]) {
    assert.deepEqual(await adminRemoveCreatorMedia(unknown), { error: "not_found" });
    assert.equal(mockListMedia().length, 1);
  }
  for (const bad of [null, undefined, "", 1]) assert.deepEqual(await adminRemoveCreatorMedia(bad), { error: "bad_request" });
  assert.deepEqual(await adminRemoveCreatorMedia("acc-you"), { ok: true, removed: 1 });
  assert.equal(mockListMedia().length, 0);
  assert.equal(mockGetTheme().background, DEFAULT_THEME.background);
  assert.deepEqual(await adminRemoveCreatorMedia("acc-you"), { ok: true, removed: 0 });
  console.log("demo media moderation: acc-you ownership, other/unknown account isolation and repeat deletion passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
