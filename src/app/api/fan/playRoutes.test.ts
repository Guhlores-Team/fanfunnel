import assert from "node:assert";
import { POST as breakPOST } from "./break/route";
import { POST as reminderPOST } from "./reminder/route";
import { POST as spinPOST } from "../spin/route";
import { mockAckFan, mockCreatePass, mockGetFanPass, mockSelfExclude, mockSetFanBlocked } from "@/lib/data/mock";
import { PLAY_ROUTE_LIMIT } from "@/lib/play/config";

// RM-6 negative tests for the two new fan endpoints. Fans are never
// authenticated: the link token is the only key, so these lock the gate.
//   - bad bodies are 400 and change nothing;
//   - an unknown token is 404, a paused or blocked link 403;
//   - the client can't pick the break end, shorten a break, or name a fan;
//   - a break makes POST /api/spin answer 403 on_break;
//   - each route is rate-limited per IP + token.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const req = (url: string, body: unknown, raw?: string) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
const brk = (body: unknown, raw?: string) => breakPOST(req("/api/fan/break", body, raw));
const rem = (body: unknown, raw?: string) => reminderPOST(req("/api/fan/reminder", body, raw));
const spin = (token: string) => spinPOST(req("/api/spin", { token, requestId: crypto.randomUUID(), clientSeed: "seed" }));

const DAY = 86_400_000;

function liveFan(name: string) {
  const f = mockCreatePass(name, 5);
  mockAckFan(f.token);
  return f;
}

async function main() {
  // --- bad input ----------------------------------------------------------------
  const a = liveFan("Route A");
  for (const [label, call] of [
    ["break: not JSON", () => brk(undefined, "nope")],
    ["break: JSON null", () => brk(undefined, "null")],
    ["break: an array", () => brk([])],
    ["break: no token", () => brk({ duration: "24h" })],
    ["break: a non-string token", () => brk({ token: { $ne: null }, duration: "24h" })],
    ["break: an oversized token", () => brk({ token: "x".repeat(300), duration: "24h" })],
    ["break: no duration", () => brk({ token: a.token })],
    ["break: an unknown duration", () => brk({ token: a.token, duration: "1h" })],
    ["break: a raw number of ms", () => brk({ token: a.token, duration: DAY })],
    ["reminder: not JSON", () => rem(undefined, "nope")],
    ["reminder: no token", () => rem({ daily: 20 })],
    ["reminder: missing daily", () => rem({ token: a.token })],
    ["reminder: an unoffered number", () => rem({ token: a.token, daily: 5 })],
    ["reminder: a string number", () => rem({ token: a.token, daily: "20" })],
  ] as const) {
    check(`${label} is 400`, (await call()).status === 400);
  }
  const pageA = await mockGetFanPass(a.token);
  check("rejected requests changed nothing", pageA?.play?.reminder === null && pageA.play.breakUntil === null);

  // --- token gating ---------------------------------------------------------------
  check("break: an unknown token is 404", (await brk({ token: "nope-" + Date.now(), duration: "24h" })).status === 404);
  check("reminder: an unknown token is 404", (await rem({ token: "nope-" + Date.now(), daily: 20 })).status === 404);
  const p = liveFan("Route Paused");
  mockSelfExclude(p.token);
  check("break: a paused link is 403", (await brk({ token: p.token, duration: "24h" })).status === 403);
  check("reminder: a paused link is 403", (await rem({ token: p.token, daily: 20 })).status === 403);
  const bl = liveFan("Route Blocked");
  mockSetFanBlocked(bl.fanId, true);
  check("break: a blocked fan's link is 403", (await brk({ token: bl.token, duration: "24h" })).status === 403);
  check("reminder: a blocked fan's link is 403", (await rem({ token: bl.token, daily: 20 })).status === 403);
  mockSetFanBlocked(bl.fanId, false);
  const blPage = await mockGetFanPass(bl.token);
  check("refused links changed nothing", blPage?.play?.reminder === null && blPage.play.breakUntil === null);

  // --- the client can't pick the end or a fan --------------------------------------
  const b = liveFan("Route B");
  const t = Date.now();
  const res = await brk({
    token: a.token,
    duration: "7d",
    until: new Date(t + 1000).toISOString(), // ignored
    breakUntil: null, // ignored
    fanId: b.fanId, // ignored
  });
  check("break: 200 for a live link", res.status === 200);
  const { breakUntil } = (await res.json()) as { breakUntil: string };
  check("break: the end is 7 days out, computed on the server", Math.abs(Date.parse(breakUntil) - (t + 7 * DAY)) < 5000);
  check("break: a body-supplied fanId reaches nobody else", (await mockGetFanPass(b.token))?.play?.breakUntil === null);
  const shorter = await brk({ token: a.token, duration: "24h" });
  check("break: asking for a shorter one never shortens it", ((await shorter.json()) as { breakUntil: string }).breakUntil === breakUntil);

  // --- a break refuses spins at the HTTP edge ---------------------------------------
  const spun = await spin(a.token);
  check("spin during a break is 403", spun.status === 403);
  check("spin during a break says on_break", ((await spun.json()) as { error?: string }).error === "on_break");
  check("another fan still spins", (await spin(b.token)).status === 200);

  // --- reminder round trip ------------------------------------------------------------
  const ok = await rem({ token: b.token, daily: 50 });
  check("reminder: 200 and echoes the number", ok.status === 200 && ((await ok.json()) as { reminder: number }).reminder === 50);
  check("reminder: the fan page reads it back", (await mockGetFanPass(b.token))?.play?.reminder === 50);
  const offRes = await rem({ token: b.token, daily: null });
  check("reminder: Off is accepted", offRes.status === 200 && (await mockGetFanPass(b.token))?.play?.reminder === null);

  // --- rate limit per IP + token ----------------------------------------------------
  const c = liveFan("Route Limited");
  let last = 200;
  for (let i = 0; i < PLAY_ROUTE_LIMIT + 1; i++) last = (await rem({ token: c.token, daily: 20 })).status;
  check(`reminder: request ${PLAY_ROUTE_LIMIT + 1} in a minute is 429`, last === 429);
  const d = liveFan("Route Limited Break");
  for (let i = 0; i < PLAY_ROUTE_LIMIT + 1; i++) last = (await brk({ token: d.token, duration: "nope" })).status;
  check("break: rejected requests still count toward the limit (429)", last === 429);

  console.log(`fan play routes: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
