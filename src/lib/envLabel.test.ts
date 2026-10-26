import assert from "node:assert";
import { envLabel, supabaseRef } from "./envLabel";

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

console.log(`envLabel.test: ${passed} checks passed`);
