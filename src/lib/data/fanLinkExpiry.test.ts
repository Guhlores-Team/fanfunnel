import assert from "node:assert/strict";
import { mock } from "node:test";

// PR-13 (0073: fan_passes.expires_at): one link can be given an expiry or
// switched off without blocking the fan. An expired link reads as paused.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => false,
    createClient: async () => { throw new Error("demo mode opens no client"); },
    createServiceClient: () => { throw new Error("demo mode uses no service role"); },
  },
});

async function main() {
  const m = await import("./mock");
  const data = await import("./index");
  const route = await import("@/app/api/fans/[fanId]/links/route");
  const fan = m.mockCreatePass("Expiry Fan", 2);
  const post = (body: unknown) => route.POST(new Request("http://localhost/api/fans/x/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ fanId: fan.fanId }) });
  const passOf = async () => (await data.getFanDetail(fan.fanId))?.passes?.find((p) => p.token === fan.token);

  check("a fresh link never expires", (await passOf())?.expiresAt === null && (await m.mockGetFanPass(fan.token)) !== null);
  const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
  let res = await post({ token: fan.token, expiresAt: inAWeek });
  check("an expiry in the future is saved", res.status === 200 && (await passOf())?.expiresAt === inAWeek && (await m.mockGetFanPass(fan.token)) !== null);
  check("an expiry in the past is refused", (await post({ token: fan.token, expiresAt: new Date(Date.now() - 1000).toISOString() })).status === 400);
  check("more than a year out is refused", (await post({ token: fan.token, expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status === 400);
  check("a value that is no date is refused", (await post({ token: fan.token, expiresAt: "soon" })).status === 400);
  check("a body with neither field is refused", (await post({ token: fan.token })).status === 400);
  check("the refusals changed nothing", (await passOf())?.expiresAt === inAWeek);

  // The demo store takes the expiry directly so the "expired" state can be read.
  m.mockUpdateFanLink(fan.fanId, fan.token, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  check("an expired link reads as paused; the fan is not blocked", (await m.mockGetFanPass(fan.token)) === null && (await data.getFanDetail(fan.fanId))?.blocked === false);
  res = await post({ token: fan.token, expiresAt: null });
  check("null clears the expiry and the link opens again", res.status === 200 && (await passOf())?.expiresAt === null && (await m.mockGetFanPass(fan.token)) !== null);
  res = await post({ token: fan.token, active: false, expiresAt: inAWeek });
  const both = await passOf();
  check("off and expiry can be set together", res.status === 200 && both?.isActive === false && both.expiresAt === inAWeek);
  check("an unknown token is a 404", (await post({ token: "nope-nope", expiresAt: null })).status === 404);

  console.log(`fanLinkExpiry.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
