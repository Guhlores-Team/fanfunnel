import assert from "node:assert";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR-13 (0073): fan_passes.expires_at. An expired link reads like a
// switched-off one on the fan page and on every token-keyed fan route.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

let row: { expires_at?: string | null } | null = null;
let failing = false;
let configured = true;
const selects: string[] = [];
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createServiceClient: () => ({
      from: (table: string) => ({
        select: (cols: string) => { selects.push(`${table}:${cols}`); return { eq: () => ({ maybeSingle: async () => (failing ? { data: null, error: { code: "42703" } } : { data: row, error: null }) }) }; },
      }),
    }),
  },
});

async function main() {
  const { linkExpired } = await import("./linkExpiry");
  const { fanLinkExpired } = await import("./linkExpiryRead");
  const now = Date.parse("2026-11-10T12:00:00Z");
  check("no expiry never ends", !linkExpired(null, now) && !linkExpired(undefined, now) && !linkExpired("", now));
  check("a future expiry is live", !linkExpired("2026-11-10T12:00:01Z", now));
  check("the expiry instant itself has ended (SQL: expires_at > now())", linkExpired("2026-11-10T12:00:00Z", now));
  check("a past expiry has ended", linkExpired("2026-11-09T00:00:00Z", now));
  check("an unreadable value is not an expiry", !linkExpired("soon", now));

  row = { expires_at: "2000-01-01T00:00:00Z" };
  check("the page read reports an expired link", (await fanLinkExpired("tok")) === true && selects[0] === "fan_passes:expires_at");
  row = { expires_at: null };
  check("…and a link with no expiry as live", (await fanLinkExpired("tok")) === false);
  row = null;
  check("an unknown token is not 'expired' (it 404s on its own)", (await fanLinkExpired("tok")) === false);
  failing = true;
  check("a database before 0073 (no column) is not expired", (await fanLinkExpired("tok")) === false);
  failing = false; configured = false; row = { expires_at: "2000-01-01T00:00:00Z" };
  check("the demo has no expiry", (await fanLinkExpired("tok")) === false);

  const root = join(__dirname, "..", "..", "..");
  const page = readFileSync(join(root, "src/app/spin/[token]/page.tsx"), "utf8");
  check("the fan page treats an expired link as no pass", page.includes("const pass = (await expired(token)) ? null : await getFanPass(token);"));
  check("…and gives it no install surface", (page.match(/await expired\(token\)/g) ?? []).length >= 3);
  const fans = readFileSync(join(root, "src/lib/data/fans.ts"), "utf8");
  const resolver = fans.slice(fans.indexOf("export async function resolveFanByToken("));
  check("the token resolver behind chat, wishlist, board and ack refuses an expired link", resolver.slice(0, 1600).includes("expires_at") && resolver.slice(0, 1600).includes("if (linkExpired(pass.expires_at)) return null;"));
  console.log(`linkExpiry.test: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
