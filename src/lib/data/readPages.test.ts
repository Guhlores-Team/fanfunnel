import assert from "node:assert/strict";
import { CompleteReadError, MAX_REPORT_PAGES, visitIdPages } from "./readPages";
import { completeReadResponse } from "@/lib/api/completeRead";
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
async function main() {
  const input = Array.from({ length: 2505 }, (_, index) => ({ id: String(index).padStart(6, "0"), cents: 3 }));
  const seen: string[] = []; let requests = 0, total = 0;
  await visitIdPages(async (after, limit) => {
    requests++;
    const remaining = input.filter(row => after === null || row.id > after);
    return { data: remaining.slice(0, Math.min(limit, 137)), count: remaining.length, error: null };
  }, rows => { seen.push(...rows.map(row => row.id)); total += rows.reduce((sum, row) => sum + row.cents, 0); });
  check("lower server cap traverses every one of2,505rows once", seen.length === 2505 && new Set(seen).size === 2505 && requests === 19 && total === 7515);
  let noCount = 0;
  await visitIdPages(async (after, limit) => ({ data: input.filter(row => after === null || row.id > after).slice(0, Math.min(limit, 200)), error: null }), rows => { noCount += rows.length; });
  check("missing exact-count metadata reads until an empty page rather than trusting a short page", noCount === 2505);
  let first = true;
  await assert.rejects(visitIdPages(async () => first ? (first = false, { data: [{ id: "a" }], count: 2, error: null }) : { data: null, error: { message: "PRIVATE DATABASE ERROR" } }, () => {}), CompleteReadError); checks++;
  await assert.rejects(visitIdPages(async () => { throw new Error("transport dropped"); }, () => {}), CompleteReadError); checks++;
  await assert.rejects(visitIdPages(async () => ({ data: [{ id: "b" }, { id: "a" }], count: 2, error: null }), () => {}), CompleteReadError); checks++;
  await assert.rejects(visitIdPages(async () => ({ data: [{ id: "a" }, { id: "a" }], count: 2, error: null }), () => {}), CompleteReadError); checks++;
  await assert.rejects(visitIdPages(async () => ({ data: [], count: 1, error: null }), () => {}), CompleteReadError); checks++;
  await assert.rejects(visitIdPages(async () => ({ data: [{ id: "a" }], count: 0, error: null }), () => {}), CompleteReadError); checks++;
  await assert.rejects(visitIdPages(async () => ({ data: [{ id: "a" }], count: Number.NaN, error: null }), () => {}), CompleteReadError); checks++;
  await assert.rejects(visitIdPages(async () => ({ data: [{ id: "a" }, { id: "b" }], count: 2, error: null }), () => {}, 1), CompleteReadError); checks++;
  const small = input.slice(0, 4); let retained = 0;
  await assert.rejects(visitIdPages(async (after, limit) => { const remaining = small.filter(row => after === null || row.id > after); return { data: remaining.slice(0, limit), count: remaining.length, error: null }; }, rows => { retained += rows.length; }, 2, 3), error => error instanceof CompleteReadError && error.reason === "limit");
  check("exact oversized counts refuse before retaining a partial report", retained === 0);
  let calls = 0;
  await assert.rejects(visitIdPages(async (after) => { calls++; const remaining = input.filter(row => after === null || row.id > after); return { data: remaining.slice(0, 1), count: remaining.length, error: null }; }, () => {}), error => error instanceof CompleteReadError && error.reason === "limit");
  check("request budget bounds a pathological tiny server page size", calls === MAX_REPORT_PAGES);
  const response = await completeReadResponse(async () => { throw new CompleteReadError("limit"); });
  const body = await response.json();
  check("budget errors produce controlled unavailable503 without a partial result", response.status === 503 && Object.keys(body).sort().join() === "dataStatus,error" && body.dataStatus === "unavailable" && response.headers.get("cache-control") === "no-store");
  await assert.rejects(completeReadResponse(async () => { throw new Error("unexpected application failure"); }), /unexpected application failure/); checks++;
  console.log(`complete report paging: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
