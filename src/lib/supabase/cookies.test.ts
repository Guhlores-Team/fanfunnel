/**
 * Locks in the session-cookie decision (backlog HARD-3).
 *
 * `httpOnly` stays false because @supabase/ssr's browser client stores the
 * session in document.cookie and these Client Components call supabase.auth.*
 * directly. This test is the living inventory of those modules: a NEW
 * browser-side client use must be added here deliberately, and if the list ever
 * empties the test fails so httpOnly:true gets re-evaluated. It also checks the
 * other attributes (sameSite=lax, Secure on https) and that all three clients
 * pass the same options.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sessionCookieOptions } from "./cookies";

const SRC = join(import.meta.dirname, "../..");
const ROOT = join(SRC, "..");
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const read = (p: string) => readFileSync(p, "utf8");

/** Client Components that need to read/write the session cookie from JS. */
const NEEDS_SESSION_COOKIE = [
  "src/components/LoginForm.tsx", // signInWithPassword / signUp write the cookie
  "src/components/dashboard/InboxPanel.tsx", // auth.getUser + Realtime channel
  "src/app/forgot-password/page.tsx", // resetPasswordForEmail
  "src/app/reset-password/page.tsx", // getSession / updateUser on the recovery link
];

let passed = 0;

// --- 1. The option set itself -----------------------------------------------
for (const [input, secure] of [
  ["https:", true],
  ["https", true],
  ["HTTPS", true],
  ["http:", false],
  ["http", false],
  ["", false],
  [null, false],
  [undefined, false],
] as const) {
  const o = sessionCookieOptions(input);
  assert.equal(o.secure, secure, `secure for ${JSON.stringify(input)}`);
  assert.equal(o.httpOnly, false, "httpOnly must stay false (browser client reads document.cookie)");
  assert.equal(o.sameSite, "lax");
  assert.equal(o.path, "/");
  passed++;
}

// --- 2. Browser, server and proxy clients all pass the shared options --------
for (const f of ["client.ts", "server.ts", "middleware.ts"]) {
  const source = read(join(SRC, "lib/supabase", f));
  assert.match(source, /cookieOptions:\s*sessionCookieOptions\(/, `${f} must pass sessionCookieOptions`);
  assert.doesNotMatch(source, /httpOnly:\s*true/, `${f} must not set httpOnly:true`);
  passed++;
}
assert.doesNotMatch(read(join(SRC, "lib/supabase/cookies.ts")), /httpOnly:\s*true/);
passed++;

// --- 3. Inventory of browser-side session users -----------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
const found = walk(SRC)
  .filter((p) => {
    const source = read(p);
    return (
      /^\s*["']use client["']/m.test(source.slice(0, 400)) &&
      /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["']@\/lib\/supabase\/client["']/.test(source)
    );
  })
  .map(rel)
  .sort();

assert.ok(
  found.length > 0,
  "No Client Component uses the browser Supabase client any more: re-evaluate httpOnly:true in src/lib/supabase/cookies.ts and update this inventory."
);
assert.deepEqual(
  found,
  [...NEEDS_SESSION_COOKIE].sort(),
  "Browser-side Supabase client users changed. If you ADDED one, confirm it needs the session cookie and list it in NEEDS_SESSION_COOKIE; if you REMOVED one, drop it from the list."
);
passed++;

// Each listed module really does call supabase.auth.* (otherwise it may not
// need the cookie at all and the list is stale).
for (const path of NEEDS_SESSION_COOKIE) {
  assert.match(read(join(ROOT, path)), /\.auth\.\w+\(/, `${path} no longer calls supabase.auth.* — is it still on the list for a reason?`);
  passed++;
}

// The browser client in this @supabase/ssr version really is document.cookie
// based; if an upgrade changes that, this is the prompt to revisit httpOnly.
const ssr = read(join(ROOT, "node_modules/@supabase/ssr/dist/main/cookies.js"));
assert.match(ssr, /document\.cookie/, "@supabase/ssr browser client no longer uses document.cookie — re-evaluate httpOnly");
passed++;

console.log(`cookies.test: ${passed} checks passed`);
