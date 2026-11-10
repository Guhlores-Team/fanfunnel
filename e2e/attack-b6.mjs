// b6 attack-audit fixes, cheap HTTP checks (demo mode):
//  N1  the demo keeps answering dashboard APIs (no Supabase, no 401); the 401
//      for a signed-out call with Supabase configured is unit-tested
//      (src/lib/api/accountAuth.test.ts).
//  N2  /verify/<unknown> is a real 404.
//  C2  random fan tokens from one address hit 429 once the miss budget is spent.
//  C3  /api/errors keeps its per-address limit and body cap.
//  C4  two wins get different server claim codes, neither the end of its share
//      id, and /verify checks a code without ever showing it.
// Requests that spend a limit carry their own x-real-ip, so no other journey's
// budget is touched. Every fixture is removed again.
import { randomBytes, randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, BASE } from "./harness.mjs";

const ip = () => `203.0.113.${1 + Math.floor(Math.random() * 250)}`;

export async function attackB6Journey(page, { step, assert }, ctx) {
  const request = ctx.request;
  const fans = [];
  try {
    await step("b6 attack N1: the demo still answers dashboard APIs (no Supabase, no 401)", async () => {
      for (const p of ["/api/overview", "/api/fans", "/api/account"]) {
        const r = await request.get(BASE + p);
        assert(r.status() === 200, `${p} answers 200 in the demo (${r.status()})`);
      }
    });

    await step("b6 attack N2: /verify/<unknown> is a 404 with the explanation", async () => {
      const r = await request.get(`${BASE}/verify/nope${randomBytes(6).toString("hex")}`);
      assert(r.status() === 404, `unknown share id → 404 (${r.status()})`);
      assert((await r.text()).includes("Nothing to verify"), "the 404 page explains it");
    });

    await step("b6 attack C2: random fan tokens from one address are cut off at the miss budget", async () => {
      const addr = ip();
      const statuses = [];
      for (let i = 0; i < 121; i++) {
        const r = await request.post(BASE + "/api/spin", { headers: { "x-real-ip": addr }, data: { token: randomBytes(24).toString("hex"), requestId: randomUUID(), clientSeed: "b6" } });
        statuses.push(r.status());
        if (r.status() === 429) break;
      }
      assert(statuses.slice(0, -1).every((s) => s === 404), `misses answer 404 until then (${[...new Set(statuses)].join(",")})`);
      assert(statuses.at(-1) === 429, `the miss after the budget answers 429 (${statuses.length} requests)`);
      const other = await request.post(BASE + "/api/spin", { headers: { "x-real-ip": ip() + "1" }, data: { token: randomBytes(24).toString("hex"), requestId: randomUUID(), clientSeed: "b6" } });
      assert(other.status() === 404, `another address still gets its 404 (${other.status()})`);
    });

    await step("b6 attack C3: /api/errors keeps its per-address limit and body cap", async () => {
      const addr = ip();
      const codes = [];
      for (let i = 0; i < 21; i++) {
        const r = await request.post(BASE + "/api/errors", { headers: { "x-real-ip": addr }, data: { message: `Error: b6 attack probe ${i}`, route: "/" } });
        codes.push(r.status());
      }
      assert(codes.slice(0, 20).every((c) => c === 204), `20 reports a minute are taken (${[...new Set(codes)].join(",")})`);
      assert(codes[20] === 429, `the 21st is refused (${codes[20]})`);
      const big = await request.post(BASE + "/api/errors", { headers: { "x-real-ip": ip() + "2" }, data: { message: "x".repeat(20 * 1024) } });
      assert(big.status() === 413, `an oversized report → 413 (${big.status()})`);
    });

    await step("b6 attack C4: two wins get different server claim codes; /verify checks one without showing it", async () => {
      const res = await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: "B6 attack claim", spins: 2 } });
      assert(res.ok(), `fixture fan (${res.status()})`);
      const fan = await res.json();
      fans.push(fan.fanId);
      assert((await acknowledgeFixtureFan(request, fan.token)).ok(), "fixture fan acknowledged");
      const wins = [];
      for (const seed of ["b6-a", "b6-b"]) {
        const r = await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: seed } });
        assert(r.ok(), `spin ${seed} (${r.status()})`);
        wins.push(await r.json());
      }
      const [a, b] = wins;
      assert(/^[0-9A-Z]{6}$/.test(a.claimCode) && /^[0-9A-Z]{6}$/.test(b.claimCode), `both wins carry a code (${a.claimCode}, ${b.claimCode})`);
      assert(a.claimCode !== b.claimCode, "the codes differ between the two wins");
      for (const w of wins) {
        assert(!String(w.shareId).toUpperCase().endsWith(w.claimCode), "the code is not the end of the share id");
      }
      const view = await request.get(`${BASE}/verify/${a.shareId}`);
      assert(view.status() === 200 && !(await view.text()).includes(a.claimCode), "the public verify page never shows the code");
      // WF-17: the check is a POST (the code never enters a URL); the no-JS
      // form post redirects back carrying only the verdict.
      const match = await (await request.post(`${BASE}/api/public/claim-check`, { data: { shareId: a.shareId, code: a.claimCode.toLowerCase() } })).json();
      assert(match.state === "match", "the creator's check accepts the right code");
      const miss = await (await request.post(`${BASE}/api/public/claim-check`, { data: { shareId: a.shareId, code: b.claimCode } })).json();
      assert(miss.state === "mismatch", "…and refuses the other win's code");
      const posted = await request.post(`${BASE}/api/public/claim-check`, { form: { shareId: a.shareId, code: b.claimCode }, maxRedirects: 0 });
      const location = posted.headers().location ?? "";
      assert(posted.status() === 303 && location.endsWith(`/verify/${a.shareId}?claimed=mismatch`), `a plain form post comes back with the verdict only (${posted.status()} ${location})`);
      const shown = await (await request.get(`${BASE}${location}`)).text();
      assert(shown.includes('data-state="mismatch"') && !shown.includes(b.claimCode), "the page shows the verdict and never the code");
      assert(!(await (await request.get(`${BASE}/verify/${a.shareId}?code=${a.claimCode}`)).text()).includes('data-state="match"'), "a code in the URL is ignored");
    });
  } finally {
    for (const id of fans) await request.delete(`${BASE}/api/fans/${id}`).catch(() => {});
  }
}
