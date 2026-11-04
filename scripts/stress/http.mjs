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
import { parallel, timed, tally } from "./metrics.mjs";

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
      const msgs = await parallel(Array.from({ length: 15 }), 15, i => call("POST", "/api/messages/fan", { body: { token: legit.token, body: `hello ${i}` }, ip: legit.ip }));
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
      const flood = await parallel(Array.from({ length: distinct }), 64, i => timed(series, () => call("GET", "/api/share-cards/none", { ip: ip(200_000 + i) })));
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
      const fan = await makePass(3), requestId = randomUUID(), series = [], statusSeries = [];
      const results = await parallel(Array.from({ length: replays }), replays, () => spin(fan, { requestId, series }));
      report.number("statuses", codes(results));
      const ok = results.filter(r => r.value.status === 200), ids = new Set(ok.map(r => r.value.json?.shareId));
      report.check(ok.length === replays && ids.size === 1, "every replay answers 200 with the same receipt", [...ids].slice(0, 2));
      report.check(ok.filter(r => r.value.json?.replayed !== true).length === 1 && ok.filter(r => r.value.json?.replayed === true).length === replays - 1, "exactly one response is the original, the rest are marked replayed");
      report.check(ok.every(r => r.value.json?.spinsRemaining === 2), "one debit: balance 3 -> 2 on every reply");
      const conflict = await spin(fan, { requestId, clientSeed: "another-seed" });
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
          edits.push(`activateB:${(await call("PATCH", `/api/wheels/${bId}`, { body: { isActive: true }, ip: editIp })).status}`);
          const camp = await call("POST", "/api/campaigns", { body: { name: "Stress campaign", pinnedWheelId: bId }, ip: editIp }); edits.push(`campaign:${camp.status}`);
          if (camp.json?.id) edits.push(`pin:${(await call("PATCH", `/api/campaigns/${camp.json.id}`, { body: { pinnedWheelId: null }, ip: editIp })).status}`);
          edits.push(`archiveB:${(await call("PATCH", `/api/wheels/${bId}`, { body: { archived: true }, ip: editIp })).status}`);
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
      const more = await parallel(Array.from({ length: batches }), 3, i => call("POST", "/api/fans/import", { body: { batchId: randomUUID(), rows: Array.from({ length: rows }, (_, j) => ({ name: `Bulk ${i}-${j}`, spins: 1, amountCents: 100 })) }, ip: nextIp() }));
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
      const subs = await parallel(Array.from({ length: 11 }), 4, i => call("POST", "/api/push/subscribe", { body: { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/stress-${i}`, keys: { p256dh: "BP".padEnd(87, "a"), auth: "b".repeat(22) } } }, ip: pushIp }));
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
      const guessed = await parallel(Array.from({ length: guesses }), 40, i => timed(guessSeries, () => call("GET", `/spin/${randomUUID().replaceAll("-", "")}`, { ip: ip(300_000 + i) })));
      report.check(guessed.every(r => r.value.status === 404), `${guesses} guessed tokens all 404`, codes(guessed));
      // Mass reports and error reports from rotating addresses stop at the global/per-IP caps.
      const reports = await parallel(Array.from({ length: 30 }), 10, i => call("POST", "/api/report", { body: { token: legit.token, reason: "spam", detail: `r${i}` }, ip: ip(400_000 + (i % 3)) }));
      const rt = codes(reports); report.number("report_statuses", rt);
      report.check((rt["429"] ?? 0) >= 15, "fan reports from 3 rotating addresses cap at 5/min each", rt);
      const errs = await parallel(Array.from({ length: 40 }), 10, i => call("POST", "/api/errors", { body: { message: `boom ${i}`, kind: "error" }, ip: ip(500_000 + (i % 2)) }));
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
      const mark = stats.serverErrors.length, reads = {};
      const routes = ["/api/overview", "/api/fans", "/api/messages/inbox", "/api/notifications", "/api/redemptions", "/api/crm", "/api/campaigns/stats", "/api/metrics?days=30"];
      const readAll = await parallel(Array.from({ length: users * iterations }), users, i => Promise.all(routes.map(r => timed(reads[r] ??= [], () => call("GET", r, { ip: ip(600_000 + (i % users)) })))));
      const flat = readAll.flatMap(r => r.value), rt = tally(flat.map(v => ({ ok: true, value: v })), v => String(v.status)); report.number("read_statuses", rt);
      report.check(Object.keys(rt).every(s => s === "200"), "every dashboard read answers 200", rt);
      for (const r of routes) report.latency(`GET ${r}`, reads[r], HTTP_THRESHOLDS.dashboardRead);
      const fans = await makePasses(fansOnPage, 1), page = [], wins = [], board = [], checkins = [];
      const natIp = [nextIp(), nextIp()];
      const loads = await parallel(fans, fansOnPage, (fan, i) => Promise.all([
        timed(page, () => call("GET", `/spin/${encodeURIComponent(fan.token)}`, { ip: natIp[i % 2] })),
        timed(wins, () => call("GET", "/api/recent-wins/acc-you", { ip: natIp[i % 2] })),
        timed(board, () => call("GET", "/api/leaderboard/acc-you", { ip: natIp[i % 2] })),
        timed(checkins, () => call("POST", "/api/fan/checkin", { body: { token: fan.token }, ip: natIp[i % 2] })),
      ]));
      const per = k => tally(loads.map(r => ({ ok: true, value: r.value[k] })), v => String(v.status));
      report.number("fan_page_statuses", per(0)); report.number("recent_wins_statuses", per(1)); report.number("leaderboard_statuses", per(2)); report.number("checkin_statuses", per(3));
      report.check(loads.every(r => r.value[0].status === 200), `${fansOnPage} fan pages all render (SSR, no limiter)`);
      // 120/min/IP on recent wins and 60/min/IP on the leaderboard: fans behind one address beyond that see 429 (documented NAT false positive, A22).
      const natFalsePositives = loads.filter(r => r.value[1].status === 429 || r.value[2].status === 429).length;
      report.number("nat_429_fans", natFalsePositives);
      report.check(loads.every(r => [200, 429].includes(r.value[1].status) && [200, 429].includes(r.value[2].status)), "shared-address fans get 200 or a clean 429 on the polled public reads (never 5xx)");
      report.check(serverErrorsSince(mark).length === 0, "no 5xx", serverErrorsSince(mark).slice(0, 2));
      const budget = Math.max(HTTP_THRESHOLDS.fanPage, HTTP_THRESHOLDS.perPageLoad * fansOnPage);
      report.latency(`GET /spin/[token] (SSR, ${fansOnPage} concurrent)`, page, budget); report.latency("GET /api/recent-wins (during the page load)", wins, budget); report.latency("GET /api/leaderboard (during the page load)", board, budget); report.latency("POST /api/fan/checkin (during the page load)", checkins, budget);
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
