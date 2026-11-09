import assert from "node:assert";
import { mock } from "node:test";

// /auth/callback and /auth/confirm (one handler, src/lib/auth/authLink.ts):
// PKCE code → session → same-origin `next`; token_hash + type → verifyOtp →
// `next` (works in any browser); the secure email change's first link
// (message, no code) → `next`; anything else → the login page's link error.
// `next` can never leave the origin.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let exchangeOk = true;
let verifyOk = true;
const verified: { type: string; token_hash: string }[] = [];
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: {
        exchangeCodeForSession: async () => ({ error: exchangeOk ? null : { message: "bad" } }),
        verifyOtp: async (p: { type: string; token_hash: string }) => {
          verified.push(p);
          return { error: verifyOk ? null : { message: "Token has expired or is invalid" } };
        },
      },
    }),
  },
});

async function main() {
  const callback = (await import("./route")).GET;
  const confirm = (await import("../confirm/route")).GET;
  const O = "https://app.example";
  const ERR = `${O}/login?error=auth_link`;
  for (const [name, GET] of [["callback", callback], ["confirm", confirm]] as const) {
    exchangeOk = true;
    verifyOk = true;
    verified.length = 0;
    const go = async (qs: string) => (await GET(new Request(`${O}/auth/${name}${qs}`))).headers.get("location");

    check(`${name}: code → next`, (await go("?code=c&next=/reset-password")) === `${O}/reset-password`);
    check(`${name}: code, no next → dashboard`, (await go("?code=c")) === `${O}/dashboard`);
    check(`${name}: absolute next is ignored`, (await go("?code=c&next=https://evil.example")) === `${O}/dashboard`);
    check(`${name}: protocol-relative next is ignored`, (await go("?code=c&next=//evil.example/x")) === `${O}/dashboard`);
    check(
      `${name}: email-change first step (message, no code) → next`,
      (await go("?message=Confirmation+link+accepted&next=/dashboard")) === `${O}/dashboard`,
    );
    check(`${name}: nothing → login error`, (await go("")) === ERR);

    // token_hash: any browser, verified server-side.
    check(`${name}: recovery token_hash → next`, (await go("?next=/reset-password&token_hash=abcdef123456&type=recovery")) === `${O}/reset-password`);
    check(`${name}: verifyOtp got the hash and type`, verified.at(-1)?.token_hash === "abcdef123456" && verified.at(-1)?.type === "recovery");
    check(`${name}: recovery with no next → reset page`, (await go("?token_hash=abcdef123456&type=recovery")) === `${O}/reset-password`);
    check(`${name}: invite with no next → set-password`, (await go("?token_hash=abcdef123456&type=invite")) === `${O}/set-password`);
    check(`${name}: signup with no next → pending`, (await go("?token_hash=abcdef123456&type=signup")) === `${O}/pending`);
    // Negative: next to another origin is refused, even on a valid token.
    check(
      `${name}: token_hash with an off-site next stays on the site`,
      (await go("?token_hash=abcdef123456&type=signup&next=https://evil.example/pending")) === `${O}/pending`,
    );
    check(
      `${name}: token_hash with a backslash next stays on the site`,
      (await go("?token_hash=abcdef123456&type=recovery&next=/%5Cevil.example")) === `${O}/reset-password`,
    );
    // Negative: a bad token_hash → the friendly error, never the target.
    const before = verified.length;
    check(`${name}: malformed token_hash → login error`, (await go("?token_hash=<script>&type=recovery")) === ERR);
    check(`${name}: unknown type → login error`, (await go("?token_hash=abcdef123456&type=admin")) === ERR);
    check(`${name}: empty token_hash → login error`, (await go("?token_hash=&type=recovery")) === ERR);
    check(`${name}: a PKCE code that also names a type still exchanges`, (await go("?type=recovery&code=c")) === `${O}/reset-password`);
    check(`${name}: malformed input never reaches Supabase`, verified.length === before);
    verifyOk = false;
    check(`${name}: expired/used token_hash → login error`, (await go("?token_hash=abcdef123456&type=recovery&next=/reset-password")) === ERR);
    exchangeOk = false;
    check(`${name}: bad code (other browser) → login error`, (await go("?code=c")) === ERR);
  }

  console.log(`✅ auth callback/confirm: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
