// Unit test for the Supabase URL normalizer — guards the "pasted /rest/v1/ or
// trailing slash breaks auth" footgun the login-UI E2E surfaced.
import { supabaseUrl } from "./url";

let passed = 0;
function eq(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    console.error(`  ✗ ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    process.exit(1);
  }
  passed++;
}

const ORIGIN = "https://abc123.supabase.co";

process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGIN;
eq(supabaseUrl(), ORIGIN, "clean origin is unchanged");

process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGIN + "/";
eq(supabaseUrl(), ORIGIN, "trailing slash stripped");

process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGIN + "/rest/v1/";
eq(supabaseUrl(), ORIGIN, "pasted Data API /rest/v1/ path normalized to origin");

process.env.NEXT_PUBLIC_SUPABASE_URL = "  " + ORIGIN + "/rest/v1  ";
eq(supabaseUrl(), ORIGIN, "surrounding whitespace + path normalized");

process.env.NEXT_PUBLIC_SUPABASE_URL = "abc123.supabase.co"; // no scheme → not a URL
eq(supabaseUrl(), "abc123.supabase.co", "non-URL falls back to trimmed value (no crash)");

console.log(`url.test: ${passed} checks passed`);
