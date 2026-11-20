import assert from "node:assert";
import { envLabel, shortCommit, supabaseRef } from "./envLabel";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

check("parses a project ref", supabaseRef("https://snmcrmhgevfqggxdiomu.supabase.co") === "snmcrmhgevfqggxdiomu");
check("tolerates a trailing slash", supabaseRef("https://snmcrmhgevfqggxdiomu.supabase.co/") === "snmcrmhgevfqggxdiomu");
check("rejects a non-Supabase URL", supabaseRef("https://example.com") === null);

const test = envLabel("https://snmcrmhgevfqggxdiomu.supabase.co");
check("TEST project is labelled TEST", test.text.includes("TEST") && test.tone === "ok");

const live = envLabel("https://ttlogfmogcccwiraaoae.supabase.co");
check("LIVE project is flagged as danger", live.text.includes("LIVE") && live.tone === "danger");

const other = envLabel("https://aaaaaaaaaaaaaaaaaaaa.supabase.co");
check("an unknown project is flagged", other.tone === "danger" && other.text.includes("aaaaaaaaaaaaaaaaaaaa"));

check("no URL means demo data", envLabel(undefined).tone === "neutral" && envLabel("").tone === "neutral");

check("OPS-13: Vercel's SHA is shortened", shortCommit({ VERCEL_GIT_COMMIT_SHA: "1617EB4abcdef0123456789abcdef0123456789a" }) === "1617eb4");
check("OPS-13: an archive deploy's SHA is used", shortCommit({ NEXT_PUBLIC_COMMIT_SHA: "d39c4fa0" }) === "d39c4fa");
check("OPS-13: Vercel's wins over the passed one", shortCommit({ VERCEL_GIT_COMMIT_SHA: "aaaaaaa", NEXT_PUBLIC_COMMIT_SHA: "bbbbbbb" }) === "aaaaaaa");
check("OPS-13: unset or junk is 'unknown'", shortCommit({}) === "unknown" && shortCommit({ NEXT_PUBLIC_COMMIT_SHA: "<script>" }) === "unknown");
console.log(`envLabel.test: ${passed} checks passed`);
