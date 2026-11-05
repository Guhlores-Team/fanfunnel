// HTTP-level load and abuse scenarios (A26) against a local `next start` in
// demo/debug mode (no Supabase env: the in-memory mock store, the same route
// handlers, limiter and validation as production). The harness starts its own
// server on STRESS_PORT (default 3274) with every Supabase/Upstash variable
// removed from the child environment, or reuses STRESS_BASE_URL when that is a
// loopback origin. It refuses to run against anything else, and refuses a
// server that reports a configured backend.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { parallel, summarize, timed, tally } from "./metrics.mjs";

const root = join(import.meta.dirname, "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ip = i => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Latency ceilings (ms, p95) on a 4-CPU box with the server sharing the CPUs; see STRESS_RESULTS.md. */
/** `perPageLoad` is the per-concurrent-fan budget for the SSR fan-page scenario (CPU-bound by design on this box). */
export const HTTP_THRESHOLDS = { spin: 400, spinContended: 1500, status: 300, publicGet: 250, dashboardRead: 1500, fanPage: 1500, perPageLoad: 20, import500: 3000, abuse: 2000, legitDuringFlood: 400 };

export async function startDemoServer(port) {
  const env = { ...process.env, NEXT_PUBLIC_ENABLE_DEBUG: "1", PORT: String(port), CRON_SECRET: "stress-cron-secret-0123456789abcdef", VAPID_SUBJECT: "mailto:stress@example.test" };
  for (const key of Object.keys(env)) if (/SUPABASE|UPSTASH|KV_REST|VERCEL|RESEND|ALERT_EMAIL/i.test(key)) delete env[key];
  const webPush = await import("web-push");
  const keys = (webPush.default ?? webPush).generateVAPIDKeys(); env.VAPID_PUBLIC_KEY = keys.publicKey; env.VAPID_PRIVATE_KEY = keys.privateKey;
  const child = spawn("npx", ["next", "start", "-p", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = ""; child.stdout.on("data", b => { output += b; if (output.length > 64_000) output = output.slice(-32_000); }); child.stderr.on("data", b => { output += b; if (output.length > 64_000) output = output.slice(-32_000); });
  const base = `http://127.0.0.1:${port}`, deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + "/", { signal: AbortSignal.timeout(5000) }); if (r.ok) return { base, child, output: () => output, cron: env.CRON_SECRET, stop: () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } } }; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw Error(`next start exited ${child.exitCode}: ${output}`);
    await sleep(500);
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  throw Error(`server did not answer on ${base} within 90s: ${output}`);
}

export async function runHttpScenarios(report, { quick = false, only = null } = {}) {
  const want = id => !only || only.has(id);
  const N = quick ? 0.3 : 1, scale = n => Math.max(4, Math.round(n * N));
  let server = null, base;
  if (process.env.STRESS_BASE_URL) {
    const u = new URL(process.env.STRESS_BASE_URL);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) throw Error("STRESS_BASE_URL must be a loopback http origin (the harness never loads a hosted deployment)");
    base = u.origin;
  } else { server = await startDemoServer(Number(process.env.STRESS_PORT || 3274)); base = server.base; }
  const cron = server?.cron ?? process.env.CRON_SECRET ?? "";
  const stats = { total: 0, byStatus: {}, serverErrors: [] };
  // One request. `ip` becomes the right-most x-forwarded-for hop (what clientIp reads on self-hosted next start).
  const call = async (method, path, { body, ip: from, headers = {}, raw = false, timeoutMs = 60_000 } = {}) => {
    const t = process.hrtime.bigint(), h = { ...(from ? { "x-forwarded-for": from } : {}), ...headers };
    let status, text, resHeaders;
    if (raw) ({ status, text, headers: resHeaders } = await rawRequest(base, method, path, h));
    else { if (body !== undefined && typeof body !== "string") { h["content-type"] = "application/json"; body = JSON.stringify(body); } else if (typeof body === "string" && !h["content-type"]) h["content-type"] = "application/json"; const r = await fetch(base + path, { method, headers: h, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); status = r.status; text = await r.text(); resHeaders = r.headers; }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    stats.total++; stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
    if (status >= 500) stats.serverErrors.push(`${method} ${path} -> ${status} ${text.slice(0, 120)}`);
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status, text, json, ms, retryAfter: resHeaders.get("retry-after"), headers: resHeaders };
  };
  const serverErrorsSince = mark => stats.serverErrors.slice(mark);
  let ipSerial = 1;
  const nextIp = () => ip(ipSerial++);
  const makePass = async (spins, { name = "Stress fan", wheelId, from = nextIp() } = {}) => {
    const r = await call("POST", "/api/passes", { body: { name, spins, requestId: randomUUID(), ...(wheelId ? { wheelId } : {}) }, ip: from });
    if (r.status !== 200 || !r.json?.token) throw Error(`pass not created: ${r.status} ${r.text.slice(0, 100)}`);
    const ack = await call("POST", "/api/fans/ack", { body: { token: r.json.token }, ip: from });
    if (ack.status !== 200) throw Error(`ack failed: ${ack.status} ${ack.text.slice(0, 100)}`);
    return { token: r.json.token, fanId: r.json.fanId, ip: from };
  };
  const makePasses = (n, spins, opts) => parallel(Array.from({ length: n }), 16, () => makePass(spins, opts)).then(rs => rs.map(r => { if (!r.ok) throw Error(r.error); return r.value; }));
  const spin = (fan, { requestId = randomUUID(), clientSeed = "stress", from = fan.ip, series } = {}) => { const go = () => call("POST", "/api/spin", { body: { token: fan.token, requestId, clientSeed }, ip: from }); return series ? timed(series, go) : go(); };
  const wheel = async () => { const r = await call("GET", "/api/wheel", { ip: nextIp() }); if (r.status !== 200) throw Error(`GET /api/wheel ${r.status}`); return r.json.wheel; };
  const saveWheel = (w, expectedStock) => call("PUT", "/api/wheel", { body: { wheel: w, ...(expectedStock ? { expectedStock } : {}) }, ip: nextIp() });
  const codes = results => tally(results, v => String(v.status));

  try {
    // Demo guard: the server must report a demo backend, never a configured one.
    const probe = await call("GET", "/api/cron/retention", { headers: { authorization: `Bearer ${cron}` } });
    if (probe.status !== 200 || probe.json?.demo !== true) throw Error(`refusing to load a non-demo server (cron probe ${probe.status} ${probe.text.slice(0, 80)})`);
    const outbox = await call("GET", "/api/push/outbox");
    if (outbox.status !== 200) throw Error("refusing: /api/push/outbox is not the demo outbox, so a backend is configured");

    // ============================================================ H1 spin floods vs A22 limits
    if (want("H1")) {
      const flood = scale(100);
      report.scenario("H1", `${flood}-request spin flood from one IP+token (limit 10/10s) while a legitimate fan keeps playing`);
      const victim = await makePass(60), legit = await makePass(20), floodIp = victim.ip, legitSeries = [], floodSeries = [], mark = stats.serverErrors.length;
      const legitLoop = async () => { const out = []; for (let i = 0; i < 10; i++) { out.push(await spin(legit, { series: legitSeries })); await sleep(30); } return out; };
      const [flooded, legitOut] = await Promise.all([parallel(Array.from({ length: flood }), 50, () => spin(victim, { from: floodIp, series: floodSeries })), legitLoop()]);
      const t = codes(flooded); report.number("flood_statuses", t);
      const accepted = flooded.filter(r => r.value.status !== 429).length, limited = flooded.filter(r => r.value.status === 429);
      report.check(accepted <= 10 && limited.length >= flood - 10, `at most 10 of ${flood} flood requests pass the route limiter`, `${accepted} accepted`);
      report.check(limited.every(r => /^\d+$/.test(r.value.retryAfter ?? "") && Number(r.value.retryAfter) >= 1 && Number(r.value.retryAfter) <= 10), "every 429 carries an integer Retry-After within the window", limited.slice(0, 3).map(r => r.value.retryAfter));
      report.check(limited.every(r => r.value.json?.error === "rate_limited"), "429 bodies say rate_limited and nothing else");
      report.check(legitOut.every(r => r.status === 200), "a legitimate fan on another IP is never throttled during the flood", codes(legitOut.map(v => ({ ok: true, value: v }))));
      const sameTokenOtherIp = await spin(victim, { from: nextIp() });
      report.check(sameTokenOtherIp.status === 200, "the flooded token from another address (carrier NAT neighbour) still spins", sameTokenOtherIp.status);
      // Per-token message cap (10/min) on the fan message route.
      const msgs = await parallel(Array.from({ length: 15 }), 15, (_, i) => call("POST", "/api/messages/fan", { body: { token: legit.token, body: `hello ${i}` }, ip: legit.ip }));
      const mt = codes(msgs); report.number("fan_message_statuses", mt);
      report.check((mt["200"] ?? 0) <= 10 && (mt["429"] ?? 0) >= 5, "fan messages cap at 10/min per token");
      report.check(serverErrorsSince(mark).length === 0, "no 5xx during the flood", serverErrorsSince(mark).slice(0, 2));
      report.latency("legit spin during flood", legitSeries, HTTP_THRESHOLDS.legitDuringFlood); report.latency("flood request (mostly 429)", floodSeries, HTTP_THRESHOLDS.spin);
      report.finish();
    }
    // ============================================================ H2 limiter capacity eviction
    if (want("H2")) {
      const distinct = quick ? 2500 : 11_000;
      report.scenario("H2", `${distinct} distinct IPs on a public route (limiter capacity 10k windows): fails open, a blocked caller stays blocked`);
      const blocked = nextIp(), mark = stats.serverErrors.length, series = [];
      const prime = await parallel(Array.from({ length: 121 }), 20, () => call("GET", "/api/share-cards/none", { ip: blocked }));
      const pt = codes(prime); report.number("prime_statuses", pt);
      report.check((pt["404"] ?? 0) === 120 && (pt["429"] ?? 0) === 1, "the 121st request from one IP on a public route (120/min) is throttled");
      const t0 = Date.now();
      const flood = await parallel(Array.from({ length: distinct }), 64, (_, i) => timed(series, () => call("GET", "/api/share-cards/none", { ip: ip(200_000 + i) })));
      const ft = codes(flood); report.number("flood_statuses", ft); report.number("throughput_rps", Math.round(distinct / ((Date.now() - t0) / 1000)));
      report.check((ft["404"] ?? 0) === distinct, "every first request from a new address is served (capacity never answers 429)", ft);
      const again = await call("GET", "/api/share-cards/none", { ip: blocked }), fresh = await call("GET", "/api/share-cards/none", { ip: nextIp() });
      report.check(again.status === 429, "the blocked address stays blocked after the eviction sweep (its window is kept last)", again.status);
      report.check(fresh.status === 404, "a fresh address after the flood is served", fresh.status);
      report.check(serverErrorsSince(mark).length === 0, "no 5xx during the address flood");
      report.latency("public GET under address flood", series, HTTP_THRESHOLDS.publicGet);
      report.finish();
    }
    // ============================================================ H3 oversell over HTTP
    if (want("H3")) {
      const n = scale(60), stock = scale(10);
      report.scenario("H3", `${n} fans spin a finite-stock prize (stock ${stock}) concurrently through /api/spin`);
      const w = await wheel(); const limited = w.prizes[0];
      w.prizes = w.prizes.map((p, i) => ({ ...p, stock: i === 0 ? stock : null, weight: i === 0 ? 1_000_000 : 1 }));
      const saved = await saveWheel(w);
      report.check(saved.status === 200, "the creator saves a finite-stock prize", `${saved.status} ${saved.text.slice(0, 80)}`);
      const fans = await makePasses(n, 1), series = [], mark = stats.serverErrors.length;
      const results = await parallel(fans, n, fan => spin(fan, { series }));
      const t = codes(results); report.number("statuses", t);
      report.check((t["200"] ?? 0) === n, `all ${n} spins answer 200`);
      const wins = results.filter(r => r.value.json?.prize?.id === limited.id).length;
      report.check(wins === stock, `exactly ${stock} fans win the limited prize`, wins);
      const after = (await wheel()).prizes.find(p => p.id === limited.id);
      report.check(after?.stock === 0, "stock lands on 0 in the creator's wheel", after?.stock);
      report.check(results.every(r => r.value.json?.spinsRemaining === 0), "every pass is debited exactly once");
      report.check(serverErrorsSince(mark).length === 0, "no 5xx");
      report.latency("spin (concurrent, one prize)", series, HTTP_THRESHOLDS.spinContended);
      report.finish();
    }
    // ============================================================ H4 idempotency over HTTP
    if (want("H4")) {
      const replays = scale(30);
      report.scenario("H4", `${replays} concurrent /api/spin with one requestId, a seed mismatch, and /api/spin/status recovery`);
      // Eight replays per address (the route limiter allows 10/10s per IP+token); the rest come from other addresses, like a device that changed networks.
      const fan = await makePass(3), requestId = randomUUID(), series = [], statusSeries = [], addresses = Array.from({ length: Math.ceil(replays / 8) }, () => nextIp());
      const results = await parallel(Array.from({ length: replays }), replays, (_, i) => spin(fan, { requestId, series, from: addresses[Math.floor(i / 8)] }));
      report.number("statuses", codes(results));
      const ok = results.filter(r => r.value.status === 200), ids = new Set(ok.map(r => r.value.json?.shareId));
      report.check(ok.length === replays && ids.size === 1, "every replay answers 200 with the same receipt", [...ids].slice(0, 2));
      report.check(ok.filter(r => r.value.json?.replayed !== true).length === 1 && ok.filter(r => r.value.json?.replayed === true).length === replays - 1, "exactly one response is the original, the rest are marked replayed");
      report.check(ok.every(r => r.value.json?.spinsRemaining === 2), "one debit: balance 3 -> 2 on every reply");
      const conflict = await spin(fan, { requestId, clientSeed: "another-seed", from: nextIp() });
      report.check(conflict.status === 409, "the same requestId with another clientSeed is a 409", conflict.status);
      const st = await timed(statusSeries, () => call("POST", "/api/spin/status", { body: { token: fan.token, requestId, clientSeed: "stress" }, ip: fan.ip }));
      report.check(st.status === 200 && st.json?.status === "committed" && st.json?.result?.shareId === [...ids][0], "/api/spin/status recovers the committed receipt", st.json?.status);
      const absent = await call("POST", "/api/spin/status", { body: { token: fan.token, requestId: randomUUID(), clientSeed: "stress" }, ip: fan.ip });
      report.check(absent.json?.status === "absent", "an unknown requestId is absent", absent.json?.status);
      report.latency("spin replay", series, HTTP_THRESHOLDS.spin); report.latency("spin/status", statusSeries, HTTP_THRESHOLDS.status);
      report.finish();
    }
    // ============================================================ H5 creator edits mid-play
    if (want("H5")) {
      const n = scale(40);
      report.scenario("H5", `${n} fans play 2 rounds while the creator saves odds/stock, creates/switches/archives games and pins a campaign`);
      const fans = await makePasses(n, 2), series = [], edits = [], mark = stats.serverErrors.length, editIp = nextIp();
      const editor = async () => {
        const w = await wheel(); const loadedStock = Object.fromEntries(w.prizes.map(p => [p.id, p.stock ?? null]));
        for (let i = 0; i < 8; i++) {
          w.prizes = w.prizes.map((p, j) => ({ ...p, weight: 1 + ((i + j) % 5), stock: j === 0 ? 5 : null }));
          edits.push(`save:${(await call("PUT", "/api/wheel", { body: { wheel: w, expectedStock: loadedStock }, ip: editIp })).status}`);
          await sleep(25);
        }
        const created = await call("POST", "/api/wheels", { body: { name: "Stress B" }, ip: editIp }); edits.push(`create:${created.status}`);
        const bId = created.json?.wheel?.id;
        if (bId) {
          // A blank game starts without prizes; 0069 refuses pinning a game with fewer than 2 (campaignPinError / aa_campaign_game).
          const b = { ...created.json.wheel, prizes: w.prizes.slice(0, 2).map((p, j) => ({ ...p, id: `stress-b${j + 1}`, stock: null })) };
          edits.push(`prizesB:${(await call("PUT", "/api/wheel", { body: { wheel: b, expectedStock: {} }, ip: editIp })).status}`);
          edits.push(`activateB:${(await call("PATCH", `/api/wheels/${bId}`, { body: { isActive: true }, ip: editIp })).status}`);
          const camp = await call("POST", "/api/campaigns", { body: { name: "Stress campaign", pinnedWheelId: bId }, ip: editIp }); edits.push(`campaign:${camp.status}`);
          const campId = camp.json?.campaign?.id;
          if (campId) edits.push(`pin:${(await call("PATCH", `/api/campaigns/${campId}`, { body: { pinnedWheelId: w.id }, ip: editIp })).status}`, `unpin:${(await call("PATCH", `/api/campaigns/${campId}`, { body: { pinnedWheelId: null }, ip: editIp })).status}`);
          // Archive is DELETE /api/wheels/[id] (no ?hard=1); PATCH { archived: true } takes the same path.
          edits.push(`archiveB:${(await call("DELETE", `/api/wheels/${bId}`, { ip: editIp })).status}`);
          edits.push(`activateA:${(await call("PATCH", `/api/wheels/${w.id}`, { body: { isActive: true }, ip: editIp })).status}`);
        }
      };
      const [results] = await Promise.all([parallel(fans.flatMap(f => [f, f]), 40, fan => spin(fan, { series })), editor()]);
      const t = codes(results); report.number("spin_statuses", t); report.number("editor", edits);
      report.check(Object.keys(t).every(s => ["200", "409", "403", "404"].includes(s)), "every spin answers 200 or a clean 4xx while the creator edits", t);
      report.check(edits.every(e => /:(200|409)$/.test(e)), "every editor call succeeds or is a clean stock_changed conflict", edits.filter(e => !/:(200|409)$/.test(e)));
      report.check(results.filter(r => r.value.status === 200).every(r => r.value.json.spinsRemaining >= 0), "balances never go negative");
      report.check(serverErrorsSince(mark).length === 0, "no 5xx", serverErrorsSince(mark).slice(0, 2));
      const after = await wheel(); report.check(after.prizes.every(p => p.stock == null || p.stock >= 0), "no negative stock after the edits");
      report.latency("spin during edits", series, HTTP_THRESHOLDS.spinContended);
      report.finish();
    }
    // ============================================================ H6 bulk import under load
    if (want("H6")) {
      const rows = 500, par = 5, n = scale(30), batches = quick ? 1 : 9;
      report.scenario("H6", `a ${rows}-row import replayed ${par}x in parallel while ${n} fans play, the per-IP cap, then ${batches} more batches to grow the store`);
      const fans = await makePasses(n, 2), series = [], importSeries = [], importIp = nextIp(), batchId = randomUUID(), mark = stats.serverErrors.length;
      const body = { batchId, rows: Array.from({ length: rows }, (_, i) => ({ name: `Imported ${i}`, spins: 1, amountCents: 0 })) };
      const [plays, imported] = await Promise.all([parallel(fans.flatMap(f => [f, f]), 30, fan => spin(fan, { series })), parallel(Array.from({ length: par }), par, () => timed(importSeries, () => call("POST", "/api/fans/import", { body, ip: importIp })))]);
      report.number("spin_statuses", codes(plays)); report.number("import_statuses", codes(imported));
      const fresh = imported.filter(r => r.value.status === 200 && r.value.json?.replayed === false), replayed = imported.filter(r => r.value.status === 200 && r.value.json?.replayed === true);
      report.check(fresh.length === 1 && replayed.length === par - 1, `one batch imported once, ${par - 1} replays`, imported.map(r => `${r.value.status}:${r.value.json?.replayed}`));
      report.check(imported.every(r => r.value.json?.created === rows && r.value.json?.failed === 0), `every receipt reports ${rows} created`);
      const sixth = await call("POST", "/api/fans/import", { body: { ...body, batchId: randomUUID() }, ip: importIp });
      report.check(sixth.status === 429, "a 6th import within a minute from the same IP is throttled (5/min)", sixth.status);
      const conflict = await call("POST", "/api/fans/import", { body: { batchId, rows: body.rows.slice(0, 10) }, ip: nextIp() });
      report.check(conflict.status === 409, "the same batchId with other rows is a 409 conflict", conflict.status);
      const more = await parallel(Array.from({ length: batches }), 3, (_, i) => call("POST", "/api/fans/import", { body: { batchId: randomUUID(), rows: Array.from({ length: rows }, (_, j) => ({ name: `Bulk ${i}-${j}`, spins: 1, amountCents: 100 })) }, ip: nextIp() }));
      report.check(more.every(r => r.value.status === 200 && r.value.json.created === rows), `${batches} further batches import cleanly`, codes(more));
      report.check(serverErrorsSince(mark).length === 0, "no 5xx");
      report.latency("spin during import", series, HTTP_THRESHOLDS.spin); report.latency("import 500 rows", importSeries, HTTP_THRESHOLDS.import500);
      report.finish();
    }
    // ============================================================ H7 push fan-out
    if (want("H7")) {
      const n = scale(20);
      report.scenario("H7", `10 push devices subscribed, then ${n} winning spins: fan-out happens after the response and never slows the spin`);
      const pushIp = nextIp(), before = (await call("GET", "/api/push/outbox")).json.deliveries.length;
      const subs = await parallel(Array.from({ length: 11 }), 4, (_, i) => call("POST", "/api/push/subscribe", { body: { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/stress-${i}`, keys: { p256dh: "BP".padEnd(87, "a"), auth: "b".repeat(22) } } }, ip: pushIp }));
      const st = codes(subs); report.number("subscribe_statuses", st);
      report.check((st["201"] ?? 0) === 10 && subs.filter(r => r.value.status >= 400).length === 1, "10 devices subscribe, the 11th is refused (device cap)");
      const fans = await makePasses(n, 1), series = [], mark = stats.serverErrors.length;
      const results = await parallel(fans, n, fan => spin(fan, { series }));
      report.check(results.every(r => r.value.status === 200), "every spin answers 200 with devices subscribed", codes(results));
      let deliveries = 0; for (let i = 0; i < 20; i++) { deliveries = (await call("GET", "/api/push/outbox")).json.deliveries.length - before; if (deliveries > 0) break; await sleep(100); }
      report.number("deliveries", deliveries);
      report.check(deliveries >= 1 && deliveries <= 10 * n, "the outbox received at least one and at most devices x spins deliveries (throttled per thread)");
      report.check(serverErrorsSince(mark).length === 0, "no 5xx");
      report.latency("spin with push fan-out", series, HTTP_THRESHOLDS.spin);
      report.finish();
    }
    // ============================================================ H9 abuse inputs
    if (want("H9")) {
      report.scenario("H9", "abuse inputs: oversized bodies, malformed JSON, unicode/HTML injection, path traversal, bad encoding, token guessing");
      const mark = stats.serverErrors.length, big = JSON.stringify({ token: "x".repeat(200), requestId: randomUUID(), clientSeed: "s", pad: "y".repeat(6 * 1024 * 1024) }), abuse = [];
      const oversized = await parallel([["POST", "/api/spin"], ["PUT", "/api/wheel"], ["POST", "/api/fans/import"], ["POST", "/api/passes"], ["POST", "/api/errors"]], 5, ([m, p]) => timed(abuse, () => call(m, p, { body: big, ip: nextIp() })));
      report.number("oversized_6MB", oversized.map(r => r.value.status));
      // Only /api/errors caps the body (413); the JSON routes parse it and validate (400, or 200/404 when the JSON is valid). Vercel caps requests at 4.5 MB in production.
      report.check(oversized.every(r => [200, 400, 404, 413].includes(r.value.status)), "a 6 MB JSON body never 5xxs: capped (413), refused (400) or parsed and validated (200/404)", oversized.map(r => r.value.status));
      const legit = await makePass(2), afterBig = await spin(legit);
      report.check(afterBig.status === 200 && afterBig.ms < HTTP_THRESHOLDS.abuse, "a legitimate spin right after the oversized bodies is served normally", Math.round(afterBig.ms));
      const malformed = await parallel([["POST", "/api/spin"], ["PUT", "/api/wheel"], ["POST", "/api/fans/import"], ["POST", "/api/passes"], ["PATCH", "/api/campaigns/none"], ["POST", "/api/report"]], 6, ([m, p]) => call(m, p, { body: '{"token": "x", "requestId": ', ip: nextIp() }));
      report.check(malformed.every(r => r.value.status === 400), "malformed JSON is a 400 everywhere", malformed.map(r => r.value.status));
      const nasty = "<img src=x onerror=alert(1)> ‮​ 🎉 ' OR 1=1 -- \u0000";
      const created = await call("POST", "/api/passes", { body: { name: nasty, spins: 1, requestId: randomUUID() }, ip: nextIp() });
      report.check(created.status === 200, "a pass with an HTML/RTL/NUL name is accepted", created.status);
      await call("POST", "/api/fans/ack", { body: { token: created.json.token }, ip: nextIp() });
      const noted = await call("PATCH", `/api/fans/${created.json.fanId}`, { body: { notes: nasty, tags: ["<b>", "‮tag"] }, ip: nextIp() });
      const detail = await call("GET", `/api/fans/${created.json.fanId}`, { ip: nextIp() });
      report.check(noted.status === 200 && detail.status === 200 && typeof detail.json?.notes === "string" && detail.json.notes.includes("<img src=x onerror=alert(1)>"), "notes and tags round-trip verbatim through JSON (no server-side mangling)");
      const page = await call("GET", `/spin/${encodeURIComponent(created.json.token)}`, { ip: nextIp() });
      report.check(page.status === 200 && !page.text.includes("<img src=x onerror") && !/onerror=alert/.test(page.text.replace(/&lt;img src=x onerror=alert\(1\)&gt;|\\u003cimg src=x onerror=alert\(1\)\\u003e|\\"<img src=x onerror=alert\(1\)>\\"/g, "")), "the fan page renders the injected name escaped (no raw <img onerror> in the HTML)", page.status);
      const board = await call("GET", "/api/leaderboard/acc-you", { ip: nextIp() });
      report.check(board.status === 200 || board.status === 404, "the public leaderboard still answers", board.status);
      const traversals = [["GET", "/api/demo/creator-media/..%2F..%2Fpackage.json"], ["GET", "/api/demo/creator-media/../../package.json"], ["GET", "/api/share-cards/..%2f..%2fetc%2fpasswd"], ["GET", "/c/..%2f..%2f.env"], ["DELETE", "/api/account/media/..%2F..%2F..%2Fetc%2Fpasswd"], ["GET", "/spin/%2e%2e%2f%2e%2e%2fetc%2fpasswd"], ["GET", "/_next/static/../../package.json"], ["GET", "/api/public/wheel/..%2f..%2fadmin"], ["GET", "/spin/%E0%A4%A"], ["GET", "/api/share-cards/%00"]];
      const trav = await parallel(traversals, 5, ([m, p]) => call(m, p, { raw: true, ip: nextIp() }));
      report.number("traversal_statuses", trav.map((r, i) => `${traversals[i][1]} -> ${r.value.status}`));
      // Demo mode serves the one demo creator for ANY slug / creator id on /c/ and the public teaser (the mock ignores the id); with Supabase these are keyed lookups. Everything else must be 400/404.
      const demoAnyId = p => /^\/(c|api\/public\/wheel)\//.test(p);
      report.check(trav.every((r, i) => ([400, 404].includes(r.value.status) || (r.value.status === 200 && demoAnyId(traversals[i][1]))) && !/"name": "fanfunnel"|root:x:0|SUPABASE/.test(r.value.text)), "every traversal/encoding probe is a 400/404 (or the demo's own page/teaser) and never serves a file", trav.map(r => r.value.status));
      const guesses = scale(300), guessSeries = [];
      const guessed = await parallel(Array.from({ length: guesses }), 40, (_, i) => timed(guessSeries, () => call("GET", `/spin/${randomUUID().replaceAll("-", "")}`, { ip: ip(300_000 + i) })));
      report.check(guessed.every(r => r.value.status === 404), `${guesses} guessed tokens all 404`, codes(guessed));
      // Mass reports and error reports from rotating addresses stop at the global/per-IP caps.
      const reports = await parallel(Array.from({ length: 30 }), 10, (_, i) => call("POST", "/api/report", { body: { token: legit.token, reason: "spam", detail: `r${i}` }, ip: ip(400_000 + (i % 3)) }));
      const rt = codes(reports); report.number("report_statuses", rt);
      report.check((rt["429"] ?? 0) >= 15, "fan reports from 3 rotating addresses cap at 5/min each", rt);
      const errs = await parallel(Array.from({ length: 40 }), 10, (_, i) => call("POST", "/api/errors", { body: { message: `boom ${i}`, kind: "error" }, ip: ip(500_000 + (i % 2)) }));
      const et = codes(errs); report.number("error_report_statuses", et);
      report.check((et["204"] ?? 0) <= 40 && (et["429"] ?? 0) >= 0 && Object.keys(et).every(s => ["204", "429"].includes(s)), "browser error reports answer 204 or 429 only", et);
      report.check(serverErrorsSince(mark).length === 0, "no 5xx from any abuse input", serverErrorsSince(mark).slice(0, 3));
      report.latency("oversized body refusal", abuse, HTTP_THRESHOLDS.abuse); report.latency("token guess (SSR 404)", guessSeries, HTTP_THRESHOLDS.fanPage);
      report.finish();
    }
    // ============================================================ H10 read paths + fan-page load
    if (want("H10")) {
      const users = scale(20), iterations = quick ? 2 : 5, fansOnPage = scale(200);
      report.scenario("H10", `dashboard reads by ${users} users x ${iterations}, then ${fansOnPage} fans load /spin, recent wins and the leaderboard behind two shared addresses`);
      const mark = stats.serverErrors.length, reads = {}, burst = {};
      const routes = ["/api/overview", "/api/fans", "/api/messages/inbox", "/api/notifications", "/api/redemptions", "/api/crm", "/api/campaigns/stats", "/api/metrics?days=30"];
      // Service time first: one dashboard, every route in turn, with the store grown by the imports (hard ceilings).
      const single = []; for (let i = 0; i < iterations; i++) for (const r of routes) single.push(await timed(reads[r] ??= [], () => call("GET", r, { ip: ip(600_000) })));
      report.check(single.every(r => r.status === 200), "every dashboard read answers 200 for one user", tally(single.map(v => ({ ok: true, value: v })), v => String(v.status)));
      for (const r of routes) report.latency(`GET ${r} (one user)`, reads[r], HTTP_THRESHOLDS.dashboardRead);
      // Then the burst: in-memory demo reads are CPU-bound on one Node process, so this is throughput, recorded, not a ceiling.
      const t0 = Date.now();
      // Each user's eight polls are one batch; a batch that cannot complete within two minutes on a busy box is counted, not a crash.
      const burstRounds = Math.max(1, Math.ceil(iterations / 2));
      const readAll = await parallel(Array.from({ length: users * burstRounds }), users, (_, i) => Promise.all(routes.map(r => timed(burst[r] ??= [], () => call("GET", r, { ip: ip(600_001 + (i % users)), timeoutMs: 120_000 })))));
      const flat = readAll.filter(r => r.ok).flatMap(r => r.value), failedBatches = readAll.filter(r => !r.ok), rt = tally(flat.map(v => ({ ok: true, value: v })), v => String(v.status)); report.number("burst_read_statuses", rt);
      report.check(Object.keys(rt).every(s => s === "200"), `every completed dashboard read answers 200 with ${users} users polling`, rt);
      report.number("burst_reads", { users, requests: flat.length, batches_timed_out: failedBatches.length, wall_ms: Date.now() - t0, rps: Math.round(flat.length / ((Date.now() - t0) / 1000)), p50_ms: Math.round(summarize(flat.map(v => v.ms)).p50 ?? 0), p95_ms: Math.round(summarize(flat.map(v => v.ms)).p95 ?? 0) });
      if (failedBatches.length) report.warn(`${failedBatches.length} burst batch(es) did not complete: ${failedBatches[0].error}`);
      const fans = await makePasses(fansOnPage, 1), page = [], wins = [], board = [], checkins = [];
      const natIp = [nextIp(), nextIp()];
      // A fan page's public reads carry its link token in x-fan-token (FanLeaderboard, RecentWinsTicker): one minute on the page is
      // the load, three recent-wins polls (every 20s) and the leaderboard twice (load + the refetch after a spin), all at the origin (no CDN here).
      const fanRead = (fan, i, path, series) => timed(series, () => call("GET", path, { ip: natIp[i % 2], headers: { "x-fan-token": fan.token } }));
      // The page load is timed (as before); the follow-up polls come after it, inside the same one-minute windows.
      const loads = await parallel(fans, fansOnPage, (fan, i) => Promise.all([
        timed(page, () => call("GET", `/spin/${encodeURIComponent(fan.token)}`, { ip: natIp[i % 2] })),
        fanRead(fan, i, "/api/recent-wins/acc-you?k=0", wins).then(v => [v]),
        fanRead(fan, i, "/api/leaderboard/acc-you?k=0", board).then(v => [v]),
        timed(checkins, () => call("POST", "/api/fan/checkin", { body: { token: fan.token }, ip: natIp[i % 2] })),
      ]));
      const followUps = [];
      await parallel(fans, 50, async (fan, i) => {
        const l = loads[i].value;
        l[1].push(await fanRead(fan, i, "/api/recent-wins/acc-you?k=1", followUps), await fanRead(fan, i, "/api/recent-wins/acc-you?k=2", followUps));
        l[2].push(await fanRead(fan, i, "/api/leaderboard/acc-you?k=1", followUps));
      });
      const per = (k, many = false) => tally(loads.flatMap(r => (many ? r.value[k] : [r.value[k]]).map(value => ({ ok: true, value }))), v => String(v.status));
      report.number("fan_page_statuses", per(0)); report.number("recent_wins_statuses", per(1, true)); report.number("leaderboard_statuses", per(2, true)); report.number("checkin_statuses", per(3));
      report.check(loads.every(r => r.value[0].status === 200), `${fansOnPage} fan pages all render (SSR, no limiter)`);
      // A22 NAT false positive: per-address windows alone (60/min leaderboard, 120/min recent wins) refused legitimate fans
      // behind one address. The shared-read limiter keys each fan by address + link token under a looser per-address ceiling.
      const refusedFans = k => loads.filter(r => r.value[k].some(v => v.status === 429)).length;
      const natFalsePositives = loads.filter(r => r.value[1].some(v => v.status === 429) || r.value[2].some(v => v.status === 429) || r.value[3].status === 429).length;
      report.number("nat_429_fans", { any: natFalsePositives, leaderboard: refusedFans(2), recent_wins: refusedFans(1), checkin: loads.filter(r => r.value[3].status === 429).length });
      report.check(natFalsePositives === 0, `0 of ${fansOnPage} legitimate fans behind two shared addresses get a 429 on the leaderboard, recent wins or check-in`, natFalsePositives);
      report.check(loads.every(r => r.value[1].every(v => v.status === 200) && r.value[2].every(v => v.status === 200) && [200, 404].includes(r.value[3].status)), "every polled public read answers 200 (check-in 200, or 404 for a demo link it does not track)", { wins: per(1, true), board: per(2, true), checkin: per(3) });
      report.check(serverErrorsSince(mark).length === 0, "no 5xx", serverErrorsSince(mark).slice(0, 2));
      const budget = Math.max(HTTP_THRESHOLDS.fanPage, HTTP_THRESHOLDS.perPageLoad * fansOnPage);
      report.latency(`GET /spin/[token] (SSR, ${fansOnPage} concurrent)`, page, budget); report.latency("GET /api/recent-wins (during the page load)", wins, budget); report.latency("GET /api/leaderboard (during the page load)", board, budget); report.latency("POST /api/fan/checkin (during the page load)", checkins, budget);
      // The abuse side of the same limiter (H1/H2 style, each from a fresh address): one address + token, an address rotating
      // forged tokens, and an address sending no token are all still capped; a neighbour's token on the flooded address is not.
      const flood = async (path, n, headersFor) => { const from = nextIp(); const rs = await parallel(Array.from({ length: n }), 50, (_, i) => call("GET", path, { ip: from, headers: headersFor(i) })); return { from, ok: rs.filter(r => r.value.status === 200).length, limited: rs.filter(r => r.value.status === 429).length, other: rs.filter(r => ![200, 429].includes(r.value.status)).length }; };
      const capped = {};
      for (const [name, path, perClient, perAddress] of [["leaderboard", "/api/leaderboard/acc-you", 60, 300], ["recent_wins", "/api/recent-wins/acc-you", 120, 600]]) {
        const token = randomUUID().replaceAll("-", ""), one = await flood(path, perClient + 40, () => ({ "x-fan-token": token }));
        const neighbour = await call("GET", path, { ip: one.from, headers: { "x-fan-token": randomUUID().replaceAll("-", "") } });
        const rotating = await flood(path, perAddress + 100, () => ({ "x-fan-token": randomUUID().replaceAll("-", "") }));
        const anonymous = await flood(path, perClient + 40, () => ({}));
        capped[name] = { one_token: one, neighbour: neighbour.status, rotating_tokens: rotating, no_token: anonymous };
        report.check(one.ok === perClient && one.limited === 40 && one.other === 0, `${name}: a flood from one address + token is capped at ${perClient}/min`, one);
        report.check(neighbour.status === 200, `${name}: another fan's token on the flooded address is still served`, neighbour.status);
        report.check(rotating.ok === perAddress && rotating.limited === 100 && rotating.other === 0, `${name}: an address rotating forged tokens is capped at the ${perAddress}/min per-address ceiling`, rotating);
        report.check(anonymous.ok === perClient && anonymous.limited === 40 && anonymous.other === 0, `${name}: requests without a token share one ${perClient}/min window per address (unchanged)`, anonymous);
      }
      report.number("abuse_caps", capped);
      report.finish();
    }
    // ============================================================ H11 Focus/Chase over HTTP (the D9 flow through the dashboard and fan routes)
    if (want("H11")) {
      const n = scale(40), rounds = 8, editIp = nextIp(), mark = stats.serverErrors.length;
      report.scenario("H11", `${n} fans spin ${rounds} rounds while the creator grants (some double-submitted), cancels Focus/Chase packs, edits the Focus prize's stock and archives its game`);
      const enable = await call("POST", "/api/debug/focus-fixture", { body: { chaseEnabled: true }, ip: editIp });
      report.check(enable.status === 200 && enable.json?.chaseEnabled === true, "Chase enabled on the demo store (debug fixture)", enable.status);
      const pack = async kind => { const r = await call("POST", "/api/campaign-packs", { body: { label: `H11 ${kind}`, spins: 6, amountCents: 0, packKind: kind, focusMultiplier: 3, focusSpins: 5, chaseWithin: 5 }, ip: editIp }); if (r.status !== 200) throw Error(`pack ${kind}: ${r.status} ${r.text.slice(0, 80)}`); return r.json.pack.id; };
      const packs = { focus: await pack("focus"), chase: await pack("chase") };
      const previous = await wheel();
      const created = await call("POST", "/api/wheels", { body: { name: "H11 Focus game" }, ip: editIp });
      const F = { ...created.json.wheel, prizes: [
        { id: "h11-common", label: "Common", rarity: "common", weight: 20, stock: null, boostable: false },
        { id: "h11-focus", label: "Focus target", rarity: "common", weight: 2, stock: 30, boostable: true },
        { id: "h11-chase", label: "Chase target", rarity: "rare", weight: 1, stock: 12, boostable: true },
        { id: "h11-rare", label: "Rare", rarity: "rare", weight: 1, stock: null, boostable: false },
      ] };
      const savedF = await call("PUT", "/api/wheel", { body: { wheel: F, expectedStock: {} }, ip: editIp });
      const activated = await call("PATCH", `/api/wheels/${F.id}`, { body: { isActive: true }, ip: editIp });
      report.check(created.status === 200 && savedF.status === 200 && activated.status === 200, "the creator sets up and activates a 4-prize Focus game", [created.status, savedF.status, activated.status]);
      const live = (await wheel()).prizes, idOf = label => live.find(p => p.label === label)?.id;
      const target = { focus: idOf("Focus target"), chase: idOf("Chase target") };
      const fans = await makePasses(n, 4), series = [], grants = [], groups = [], cancels = [], edits = [];
      for (const fan of fans) { const r = await call("GET", `/api/fans/${fan.fanId}/focus`, { ip: nextIp() }); fan.passId = r.json?.passes?.[0]?.id; }
      report.check(fans.every(f => f.passId), "every fan's pass is visible to the creator's focus panel");
      let playing = true, archived = false;
      const fanLoop = async fan => { const out = []; for (let i = 0; i < rounds; i++) { const r = await spin(fan, { series }); out.push(r); if (r.status !== 200) break; await sleep(40); } return out; };
      const grantOnce = async (fan, kind, copies) => {
        const body = { requestId: randomUUID(), packId: packs[kind], prizeId: target[kind], passId: fan.passId };
        const rs = await parallel(Array.from({ length: copies }), copies, () => call("POST", `/api/fans/${fan.fanId}/focus`, { body, ip: nextIp() }));
        const out = rs.map(r => r.value); grants.push(...out.map(r => r.status === 200 ? "granted" : `${r.status}:${r.json?.error}`));
        if (copies > 1) groups.push(out);
        if (out.some(r => r.status === 200)) fan.packs = (fan.packs ?? 0) + 1;
      };
      const creator = async worker => {
        for (let i = worker; playing; i += 2) {
          const fan = fans[(i % 3 === 2 ? i - 1 : i) % n];
          if (archived) { await sleep(20); continue; }
          // Every third step cancels the promise just granted to the previous fan (if it was).
          if (i % 3 === 2) { const r = await call("GET", `/api/fans/${fan.fanId}/focus`, { ip: nextIp() }); if (r.json?.focusId) { const c = await call("DELETE", `/api/fans/${fan.fanId}/focus`, { body: { focusId: r.json.focusId }, ip: nextIp() }); cancels.push(c.status === 200 ? `released:${c.json?.released}` : `${c.status}:${c.json?.error}`); continue; } }
          await grantOnce(fan, i % 2 ? "chase" : "focus", i % 5 === 0 ? 3 : 1);
          await sleep(10);
        }
      };
      const editor = async () => {
        const stale = await wheel(); const staleStock = Object.fromEntries(stale.prizes.map(p => [p.id, p.stock ?? null]));
        for (let i = 0; i < 6 && playing; i++) {
          await sleep(60);
          const w = i % 3 === 2 ? stale : await wheel(); const expectedStock = i % 3 === 2 ? staleStock : Object.fromEntries(w.prizes.map(p => [p.id, p.stock ?? null]));
          const prizes = w.prizes.map(p => p.id === target.focus && i % 3 !== 2 ? { ...p, stock: (p.stock ?? 0) + (i % 2 ? -1 : 3) } : p);
          const r = await call("PUT", "/api/wheel", { body: { wheel: { ...w, prizes }, expectedStock }, ip: editIp }); edits.push(`${i % 3 === 2 ? "stale" : "save"}:${r.status}`);
        }
        while (playing && fans.filter(f => f.done).length < n / 2) await sleep(20);
        const a = await call("DELETE", `/api/wheels/${F.id}`, { ip: editIp }); edits.push(`archive:${a.status}`);
        const back = await call("PATCH", `/api/wheels/${previous.id}`, { body: { isActive: true }, ip: editIp }); edits.push(`activate previous:${back.status}`);
        archived = true;
      };
      const [plays] = await Promise.all([parallel(fans, n, fan => fanLoop(fan).finally(() => { fan.done = true; })).finally(() => { playing = false; }), creator(0), creator(1), editor()]);
      const flat = plays.flatMap(r => r.value); report.number("spin_statuses", codes(flat.map(v => ({ ok: true, value: v }))));
      report.number("grants", tally(grants.map(v => ({ ok: true, value: v })), v => v)); report.number("cancels", tally(cancels.map(v => ({ ok: true, value: v })), v => v)); report.number("editor", edits);
      const won = flat.filter(r => r.status === 200).map(r => r.json);
      report.number("modifiers", { focusConsumed: won.filter(r => r.focusConsumed).length, chaseConsumed: won.filter(r => r.chaseConsumed).length, chaseCompleted: won.filter(r => r.chaseCompleted).length, chaseAwarded: won.filter(r => r.chaseAwarded).length, pityAwarded: won.filter(r => r.pityAwarded).length });
      report.check(serverErrorsSince(mark).length === 0, "no 5xx", serverErrorsSince(mark).slice(0, 2));
      report.check(flat.every(r => r.status === 200 || (r.status === 409 && r.json?.error === "no_spins")), "every spin answers 200 until the fan's credits run out", codes(flat.map(v => ({ ok: true, value: v }))));
      report.check(grants.every(g => g === "granted" || /^409:(focus_exists|sold_out|invalid_target|rejected|unavailable)$/.test(g)), "every purchase is granted or a clean 409 refusal", grants.filter(g => g !== "granted" && !/^409:/.test(g)).slice(0, 3));
      report.check(groups.every(g => { const ok = g.filter(r => r.status === 200); return ok.length === 0 ? new Set(g.map(r => r.status)).size === 1 : ok.length === g.length && new Set(ok.map(r => r.json.grantId)).size === 1 && ok.filter(r => r.json.replayed === false).length === 1; }), `${groups.length} double-submitted purchases apply once (one grant, the copies replayed)`);
      report.check(cancels.every(c => /^released:(true|false)$/.test(c)), "every cancel answers 200", cancels.filter(c => !/^released:/.test(c)).slice(0, 3));
      report.check(won.filter(r => r.chaseAwarded).every(r => r.prize?.id === target.chase && r.chaseCompleted), "every forced Chase award is the Chase target and completes the promise");
      report.check(edits.every(e => /:(200|409)$/.test(e)) && edits.includes("archive:200"), "every stock save is 200 or a clean stock_changed 409, and the game is archived mid-play", edits);
      const spun = new Map(fans.map(f => [f, plays[fans.indexOf(f)].value.filter(r => r.status === 200).length]));
      const panels = await parallel(fans, 8, fan => call("GET", `/api/fans/${fan.fanId}/focus`, { ip: nextIp() }));
      const balanceOff = fans.filter((fan, i) => panels[i].value.json?.passes?.[0]?.spinsRemaining !== 4 + 6 * (fan.packs ?? 0) - spun.get(fan));
      report.check(balanceOff.length === 0, "each fan's balance is 4 + 6 per granted pack - spins played (the ledger, double-submits counted once)", balanceOff.slice(0, 2).map(f => ({ packs: f.packs, spun: spun.get(f), panel: panels[fans.indexOf(f)].value.json?.passes?.[0]?.spinsRemaining })));
      report.check(panels.every(r => r.value.status === 200 && (r.value.json.focus == null || r.value.json.focus.prizeId !== target.focus && r.value.json.focus.prizeId !== target.chase)), "no promise survives on the archived game's prizes", panels.filter(r => !(r.value.status === 200 && (r.value.json.focus == null || r.value.json.focus.prizeId !== target.focus && r.value.json.focus.prizeId !== target.chase))).slice(0, 2).map(r => ({ status: r.value.status, focus: r.value.json?.focus })));
      const fAfter = await call("GET", `/api/wheels/${F.id}`, { ip: editIp }), chaseLeft = fAfter.json?.wheel?.prizes?.find(p => p.id === target.chase)?.stock;
      const chaseWins = won.filter(r => r.prize?.id === target.chase).length;
      report.number("chase_stock", { left: chaseLeft ?? null, won: chaseWins, read: fAfter.status });
      report.check(fAfter.status === 200 && typeof chaseLeft === "number" && chaseLeft >= 0, "the archived game's Chase prize stock is readable and never negative", { status: fAfter.status, chaseLeft });
      // The demo store's saveWheel ignores expectedStock (SQL save_wheel_prizes applies the editor's delta, D3/D9), so a
      // save that races a win puts the won unit back: demo-only, documented in STRESS_RESULTS.md.
      report.known("DEMO_SAVE_IGNORES_EXPECTED_STOCK", chaseLeft + chaseWins === 12, "Chase stock conserved over HTTP: 12 = left + won (held units returned on archive)", { chaseLeft, chaseWins });
      report.latency("spin during focus/chase grants", series, HTTP_THRESHOLDS.spinContended);
      report.finish();
    }
    // ============================================================ H8 cron, fan deletion and account reset while activity continues (last: it clears the store)
    if (want("H8")) {
      const n = scale(20);
      report.scenario("H8", `retention cron twice in parallel, a fan deleted mid-play, then an account reset while ${n} fans play`);
      const mark = stats.serverErrors.length, fans = await makePasses(n, 3), series = [], cronSeries = [];
      const victim = fans[0];
      const [plays, crons, deletion] = await Promise.all([
        parallel(fans.flatMap(f => [f, f, f]), 30, fan => spin(fan, { series })),
        parallel([0, 1], 2, () => timed(cronSeries, () => call("GET", "/api/cron/retention", { headers: { authorization: `Bearer ${cron}` } }))),
        (async () => { await sleep(10); return call("DELETE", `/api/fans/${victim.fanId}`, { ip: nextIp() }); })(),
      ]);
      report.number("spin_statuses", codes(plays)); report.number("cron_statuses", codes(crons));
      report.check(crons.every(r => r.value.status === 200 && r.value.json?.ok === true), "both concurrent cron runs answer ok");
      report.check(deletion.status === 200, "the fan deletion mid-play succeeds", deletion.status);
      const victimPlays = plays.filter((_, i) => fans[Math.floor(i / 3)] === victim), others = plays.filter((_, i) => fans[Math.floor(i / 3)] !== victim);
      report.check(others.every(r => r.value.status === 200), "other fans' plays all answer 200 during cron and deletion", codes(others));
      report.check(victimPlays.every(r => [200, 404].includes(r.value.status)), "the deleted fan's plays answer 200 (before) or 404 (after), never 5xx", codes(victimPlays));
      const unauth = await call("GET", "/api/cron/retention", { headers: { authorization: "Bearer wrong" } });
      report.check(unauth.status === 401, "a wrong cron secret is 401", unauth.status);
      const after = await spin(victim); report.check(after.status === 404, "the deleted fan's link is gone", after.status);
      const resetIp = nextIp(), survivors = fans.slice(1, 11), resetSeries = [];
      const [resetPlays, reset] = await Promise.all([parallel(survivors.flatMap(f => [f, f]), 20, fan => spin(fan, { series: resetSeries })), (async () => { await sleep(5); return call("POST", "/api/account/reset", { body: { confirm: "RESET" }, ip: resetIp }); })()]);
      report.number("reset", reset.status); report.number("spins_during_reset", codes(resetPlays));
      report.check(reset.status === 200, "the account reset succeeds while fans play", `${reset.status} ${reset.text.slice(0, 60)}`);
      report.check(resetPlays.every(r => [200, 404, 409].includes(r.value.status)), "spins racing the reset answer 200 or a clean 404/409");
      const gone = await spin(survivors[0]); report.check(gone.status === 404, "links are gone after the reset", gone.status);
      report.check(serverErrorsSince(mark).length === 0, "no 5xx", serverErrorsSince(mark).slice(0, 2));
      report.latency("spin during cron/deletion", series, HTTP_THRESHOLDS.spin); report.latency("cron retention", cronSeries, HTTP_THRESHOLDS.abuse);
      report.finish();
    }
    report.scenario("H0", "server totals"); report.number("requests", stats.total); report.number("by_status", stats.byStatus); report.check(stats.serverErrors.length === 0, "no 5xx across the whole HTTP run", stats.serverErrors.slice(0, 3)); report.finish();
  } finally {
    if (server) { if (process.env.STRESS_SERVER_LOG) { const { writeFileSync } = await import("node:fs"); writeFileSync(process.env.STRESS_SERVER_LOG, server.output()); } server.stop(); }
  }
}

/** A request with the path sent byte-for-byte (fetch would normalise `..` segments). */
function rawRequest(base, method, path, headers) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, method, path, headers }, res => { let text = ""; res.setEncoding("utf8"); res.on("data", c => { if (text.length < 20_000) text += c; }); res.on("end", () => resolve({ status: res.statusCode, text, headers: new Headers(Object.entries(res.headers).filter(([, v]) => typeof v === "string")) })); });
    req.on("error", reject); req.end();
  });
}
