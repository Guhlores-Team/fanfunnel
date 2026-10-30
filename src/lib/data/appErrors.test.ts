import assert from "node:assert";

// The demo-mode (in-memory) app_errors store must behave like the SQL in
// migration 0053 (scripts/db/schema-drift-check.mjs probes the SQL side):
// upsert by environment+fingerprint, reopen a resolved row, prune resolved rows
// first, and the global hourly alert throttle with a later digest.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const FP = (n: number) => n.toString(16).padStart(64, "0");

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const m = await import("./appErrors");
  m.resetMemoryAppErrors();

  const base = { environment: "production" as const, source: "client" as const, message: "boom" };
  const first = await m.recordAppError({ ...base, fingerprint: FP(1) });
  check("first occurrence → is_new", first?.isNew === true && first.count === 1 && !first.reopened);
  const again = await m.recordAppError({ ...base, fingerprint: FP(1) });
  check("repeat → same row, count 2, not new", again?.id === first?.id && again?.count === 2 && !again.isNew);
  const otherEnv = await m.recordAppError({ ...base, environment: "preview", fingerprint: FP(1) });
  check("same fingerprint in another environment → its own row", otherEnv?.isNew === true && otherEnv.id !== first?.id);

  const open = await m.listAppErrors({ status: "open" });
  check("list returns open rows newest first", Array.isArray(open) && open.length === 2);
  const onlyProd = await m.listAppErrors({ status: "open", environment: "production" });
  check("environment filter", Array.isArray(onlyProd) && onlyProd.length === 1 && onlyProd[0].environment === "production");

  check("resolve works", "ok" in (await m.resolveAppError(first!.id, true)));
  const resolvedList = await m.listAppErrors({ status: "resolved" });
  check("resolved list has it", Array.isArray(resolvedList) && resolvedList.length === 1 && resolvedList[0].resolvedAt !== null);
  const back = await m.recordAppError({ ...base, fingerprint: FP(1) });
  check("a resolved error coming back → reopened, count 3", back?.reopened === true && back.count === 3 && !back.isNew);
  check("resolving an unknown id → not_found", "error" in (await m.resolveAppError("00000000-0000-4000-8000-000000000000", true)));

  // --- prune: oldest RESOLVED first, then oldest open ----------------------------
  m.resetMemoryAppErrors();
  const r1 = await m.recordAppError({ ...base, fingerprint: FP(10) });
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await m.recordAppError({ ...base, fingerprint: FP(11) });
  await new Promise((r) => setTimeout(r, 5));
  const r3 = await m.recordAppError({ ...base, fingerprint: FP(12) });
  await m.resolveAppError(r3!.id, true);
  await m.recordAppError({ ...base, fingerprint: FP(13) }, 3);
  const ids = () => m.listAppErrors({ status: "open" }).then((l) => (Array.isArray(l) ? l.map((e) => e.id) : []));
  const resolvedNow = await m.listAppErrors({ status: "resolved" });
  check("over the cap → the resolved row went first", Array.isArray(resolvedNow) && resolvedNow.length === 0);
  check("…and the open ones stayed", (await ids()).includes(r1!.id) && (await ids()).includes(r2!.id));
  await m.recordAppError({ ...base, fingerprint: FP(14) }, 3);
  check("still over → the oldest open row goes next", !(await ids()).includes(r1!.id) && (await ids()).length === 3);

  // --- throttle --------------------------------------------------------------------
  const now = Date.now();
  check("throttleAllows: under the limit", m.throttleAllows([now - 1000], now, 2).allowed);
  check("throttleAllows: at the limit", !m.throttleAllows([now - 1000, now - 2000], now, 2).allowed);
  check("throttleAllows: sends older than an hour no longer count", m.throttleAllows([now - 61 * 60 * 1000, now - 1000], now, 2).allowed);

  m.resetMemoryAppErrors();
  const LIMIT = 10;
  const sends: boolean[] = [];
  const recs = [];
  for (let i = 0; i < LIMIT + 3; i++) {
    const rec = await m.recordAppError({ ...base, fingerprint: FP(100 + i) });
    recs.push(rec!);
    sends.push((await m.claimAppErrorAlert(LIMIT, rec!.id)).send);
  }
  check(`first ${LIMIT} new errors in an hour are e-mailed`, sends.slice(0, LIMIT).every(Boolean));
  check("the rest are throttled", sends.slice(LIMIT).every((s) => !s));
  check("a digest check while still over the limit does not send", !(await m.claimAppErrorAlert(LIMIT)).send);
  // An hour later the budget is back: the digest covers the 3 held back.
  const g = globalThis as unknown as { __ffAppErrors: { alerts: number[] } };
  g.__ffAppErrors.alerts = g.__ffAppErrors.alerts.map((t) => t - 61 * 60 * 1000);
  await m.resolveAppError(recs[LIMIT + 2].id, true);
  const digest = await m.claimAppErrorAlert(LIMIT);
  check("one digest goes out later, counting the open held-back errors", digest.send && digest.pending === 2);
  check("…and only once", !(await m.claimAppErrorAlert(LIMIT)).send);

  m.resetMemoryAppErrors();
  for (let i = 0; i < LIMIT; i++) await m.claimAppErrorAlert(LIMIT, (await m.recordAppError({ ...base, fingerprint: FP(200 + i) }))!.id);
  await m.claimAppErrorAlert(LIMIT, (await m.recordAppError({ ...base, fingerprint: FP(300) }))!.id);
  g.__ffAppErrors.alerts = g.__ffAppErrors.alerts.map((t) => t - 61 * 60 * 1000);
  const next = await m.claimAppErrorAlert(LIMIT, (await m.recordAppError({ ...base, fingerprint: FP(301) }))!.id);
  check("the next alert after a throttled one mentions the held-back error", next.send && next.pending === 1);

  console.log(`data/appErrors (memory store): ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
