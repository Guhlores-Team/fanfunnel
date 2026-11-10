import assert from "node:assert/strict";
import { mock } from "node:test";

// TS-17 negative and positive tests for POST /api/fan/mute (demo mode, the
// mock store is the parity twin of set_fan_chat_mute + guard_message_writes):
//   - a bad body or token is 400 and changes nothing;
//   - a request carrying the creator's session is refused (403) before any
//     of the fan's limits, and changes nothing;
//   - an unknown token is 404 and counts against the address's miss budget;
//     a paused, switched-off or expired link, a blocked fan and a suspended
//     creator's link answer 404 too (the acknowledgement's answer) and
//     change nothing;
//   - mute / unmute round trip, private no-store; muting again keeps the
//     first time;
//   - while muted the creator's send is refused (409 muted) and the auto
//     intro / outro are skipped; after unmute the send works again;
//   - the route is rate-limited per address and token (429).

let sessionCookie = false;
mock.module("next/headers", { namedExports: {
  cookies: async () => ({ getAll: () => (sessionCookie ? [{ name: "sb-demo-auth-token", value: "x" }] : []) }),
  headers: async () => new Headers(),
} });

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

let n = 0;
const nextIp = () => `198.51.${100 + Math.floor(n / 250)}.${1 + (n++ % 250)}`;
const req = (url: string, body: unknown, { raw, ip = nextIp() }: { raw?: string; ip?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: raw ?? JSON.stringify(body),
  });

async function main() {
  const { POST: mutePOST } = await import("./route");
  const { POST: creatorPOST } = await import("@/app/api/messages/creator/route");
  const { POST: introPOST } = await import("@/app/api/messages/auto-intro/route");
  const { POST: outroPOST } = await import("@/app/api/messages/auto-outro/route");
  const m = await import("@/lib/data/mock");
  const { PLAY_ROUTE_LIMIT } = await import("@/lib/play/config");
  const { FAN_MISS_LIMIT, resetFanMissBlocks } = await import("@/lib/api/fanMiss");
  const { CREATOR_SESSION_ERROR } = await import("@/lib/fan/creatorGuard");

  const mute = (body: unknown, opts?: { raw?: string; ip?: string }) => mutePOST(req("/api/fan/mute", body, opts));
  const creatorSend = (fanId: string, body: string) => creatorPOST(req("/api/messages/creator", { fanId, body }));
  const liveFan = (name: string) => { const f = m.mockCreatePass(name, 3); m.mockAckFan(f.token); return f; };
  const mutedNow = async (token: string) => (await m.mockGetFanPass(token))?.chatMuted === true;
  const exported = (token: string) => m.mockExportFanData(token)!;

  // --- bad bodies and tokens ------------------------------------------------------
  const a = liveFan("Mute A");
  for (const [label, call] of [
    ["not JSON", () => mute(undefined, { raw: "nope" })],
    ["JSON null", () => mute(undefined, { raw: "null" })],
    ["an array", () => mute([])],
    ["no token", () => mute({ muted: true })],
    ["an empty token", () => mute({ token: "", muted: true })],
    ["a non-string token", () => mute({ token: { $ne: null }, muted: true })],
    ["an oversized token", () => mute({ token: "x".repeat(300), muted: true })],
    ["no muted", () => mute({ token: a.token })],
    ["a string muted", () => mute({ token: a.token, muted: "true" })],
    ["a null muted", () => mute({ token: a.token, muted: null })],
    ["a number muted", () => mute({ token: a.token, muted: 1 })],
  ] as const) {
    check(`${label} is 400`, (await call()).status === 400);
  }
  check("rejected requests changed nothing", !(await mutedNow(a.token)));

  // --- the creator's own session is refused -------------------------------------------
  sessionCookie = true;
  const refused = await mute({ token: a.token, muted: true });
  const refusal = (await refused.json()) as { error?: string };
  check("a request carrying the creator's session is 403 creator_session", refused.status === 403 && refusal.error === CREATOR_SESSION_ERROR);
  check("…and the fan is not muted", !(await mutedNow(a.token)));
  sessionCookie = false;

  // --- not_found / unavailable --------------------------------------------------------
  check("an unknown token is 404", (await mute({ token: "nope-" + Date.now(), muted: true })).status === 404);
  const paused = liveFan("Mute paused");
  m.mockSelfExclude(paused.token);
  check("a paused link is 404", (await mute({ token: paused.token, muted: true })).status === 404);
  const off = liveFan("Mute off");
  m.mockUpdateFanLink(off.fanId, off.token, { active: false });
  check("a switched-off link is 404", (await mute({ token: off.token, muted: true })).status === 404);
  const expired = liveFan("Mute expired");
  m.mockUpdateFanLink(expired.fanId, expired.token, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  check("an expired link is 404", (await mute({ token: expired.token, muted: true })).status === 404);
  const blocked = liveFan("Mute blocked");
  m.mockSetFanBlocked(blocked.fanId, true);
  check("a blocked fan's link is 404 (unavailable)", (await mute({ token: blocked.token, muted: true })).status === 404);
  m.mockSetFanBlocked(blocked.fanId, false);
  check("…and nothing was written for the blocked fan", exported(blocked.token).consents.chatMutedAt === null);
  m.mockSetDemoCreatorActive(false);
  check("a suspended creator's link is 404 (unavailable)", (await mute({ token: a.token, muted: true })).status === 404);
  m.mockSetDemoCreatorActive(true);
  check("refused links changed nothing", !(await mutedNow(a.token)) && exported(paused.token).consents.chatMutedAt === null);

  // --- the miss budget is the fan routes' own ------------------------------------------
  resetFanMissBlocks();
  const crowd = "198.18.7.7";
  let last = 0;
  for (let i = 0; i <= FAN_MISS_LIMIT.limit; i++) last = (await mute({ token: `miss-${i}-${Date.now()}`, muted: true }, { ip: crowd })).status;
  check("misses past the address's budget answer 429", last === 429);
  const hit = await mute({ token: a.token, muted: false }, { ip: crowd });
  check("a real link from that address is still answered (ATK-04)", hit.status === 200);
  resetFanMissBlocks();

  // --- mute, refusal, unmute ----------------------------------------------------------
  const res = await mute({ token: a.token, muted: true });
  check("mute is 200 { muted: true }", res.status === 200 && ((await res.json()) as { muted?: boolean }).muted === true);
  check("the answer is private, no-store", /private/.test(res.headers.get("cache-control") ?? "") && /no-store/.test(res.headers.get("cache-control") ?? ""));
  check("the fan page reads it back", await mutedNow(a.token));
  const first = exported(a.token).consents.chatMutedAt;
  check("the fan's export carries when they muted", typeof first === "string" && !Number.isNaN(Date.parse(first!)));
  await new Promise((r) => setTimeout(r, 5));
  check("muting again is ok and keeps the first time", (await mute({ token: a.token, muted: true })).status === 200 && exported(a.token).consents.chatMutedAt === first);
  check("the creator's fans export carries chat_muted_at", m.mockExportCreatorData().sections.fans.some((row) => row.id === a.fanId && row.chat_muted_at === first));
  check("the creator's drawer shows the fan as muted", m.mockGetFanDetail(a.fanId)?.chatMuted === true);

  const before = m.mockGetThread(a.fanId).length;
  const sent = await creatorSend(a.fanId, "hello while muted");
  check("the creator's send is 409 muted", sent.status === 409 && ((await sent.json()) as { error?: string }).error === "muted");
  check("…and no message was stored", m.mockGetThread(a.fanId).length === before);
  m.mockSetChatSettings({ intro: "Welcome to my game!", outro: "Out of spins, see you soon!" });
  const fresh = liveFan("Mute fresh");
  check("a fresh fan mutes before opening chat", (await mute({ token: fresh.token, muted: true })).status === 200);
  check("the auto intro answers ok for a muted fan…", (await introPOST(req("/api/messages/auto-intro", { token: fresh.token }))).status === 200);
  check("the auto outro answers ok for a muted fan…", (await outroPOST(req("/api/messages/auto-outro", { token: fresh.token }))).status === 200);
  check("…and neither wrote a message", m.mockGetThread(fresh.fanId).length === 0);

  const back = await mute({ token: a.token, muted: false });
  check("unmute is 200 { muted: false }", back.status === 200 && ((await back.json()) as { muted?: boolean }).muted === false);
  check("the fan page and export read it back", !(await mutedNow(a.token)) && exported(a.token).consents.chatMutedAt === null);
  check("the creator's send works again", (await creatorSend(a.fanId, "hello again")).status === 200 && m.mockGetThread(a.fanId).some((x) => x.body === "hello again"));
  check("unmuting the fresh fan lets the intro through", (await mute({ token: fresh.token, muted: false })).status === 200 && (await introPOST(req("/api/messages/auto-intro", { token: fresh.token }))).status === 200 && m.mockGetThread(fresh.fanId).some((x) => x.body === "Welcome to my game!"));
  m.mockSetChatSettings({ intro: null, outro: null });

  // --- TS-13 export fields in the demo twin ---------------------------------------------
  const exp = exported(a.token);
  check("TS-13: the demo export's top-ups carry amountCents", exp.topUps.length > 0 && exp.topUps.every((t) => typeof t.amountCents === "number"));
  check("TS-13: the demo export says whether the fan is blocked", exp.profile.blocked === false && exported(blocked.token).profile.blocked === false);
  m.mockSetFanBlocked(blocked.fanId, true);
  check("TS-13: …and true once blocked", exported(blocked.token).profile.blocked === true);

  // --- rate limit per address + token ------------------------------------------------------
  const c = liveFan("Mute limited");
  const ip = "198.51.200.9";
  let status = 0;
  for (let i = 0; i < PLAY_ROUTE_LIMIT + 1; i++) status = (await mute({ token: c.token, muted: i % 2 === 0 }, { ip })).status;
  check(`request ${PLAY_ROUTE_LIMIT + 1} in a minute is 429`, status === 429);
  const d = liveFan("Mute limited bad");
  for (let i = 0; i < PLAY_ROUTE_LIMIT + 1; i++) status = (await mute({ token: d.token, muted: "nope" }, { ip })).status;
  check("rejected bodies still count toward the limit (429)", status === 429);

  console.log(`fan mute route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
