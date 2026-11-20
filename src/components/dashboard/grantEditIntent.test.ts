import assert from "node:assert/strict";
import { buildGrantEditPatch, grantEditFields, grantEditScope, rebaseGrantEditFields, submitGrantEdit } from "./grantEditIntent";
import { readCreatorIntent } from "./creatorIntent";
import { releaseCreatorRequest } from "./creatorRequestOutcome";

async function main() {
  const grant = { id: "grant-private", spins: 3, amountCents: 1000, campaignId: "campaign-private" };
  const fields = grantEditFields(grant);
  assert.deepEqual(buildGrantEditPatch(grant, fields), {}, "opening the rounded $3.33 field must not change the exact $10 saved total");
  assert.deepEqual(buildGrantEditPatch(grant, { ...fields, campaignId: "" }), { campaignId: null }, "clearing a campaign is explicit; unchanged price/spins are omitted");
  assert.deepEqual(buildGrantEditPatch(grant, { ...fields, spins: "6" }), { spins: 6, amountCents: 2000 }, "changing quantity scales the exact original rate");
  assert.deepEqual(buildGrantEditPatch(grant, { ...fields, perSpin: "4" }), { amountCents: 1200 });
  const newer = { ...grant, spins: 5, amountCents: 2000, campaignId: "campaign-new" };
  assert.deepEqual(rebaseGrantEditFields(grant, newer, { ...fields, campaignId: "" }), { spins: "5", perSpin: "4.00", campaignId: "" }, "review preserves the explicitly cleared campaign while adopting unrelated current server terms");
  assert.deepEqual(rebaseGrantEditFields(grant, newer, { ...fields, spins: "6", perSpin: "5" }), { spins: "6", perSpin: "5", campaignId: "campaign-new" });

  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  const scope = grantEditScope(grant.id);
  const patch = { spins: 20, campaignId: null };
  let calls = 0;
  let originalId = "";
  const pending = await submitGrantEdit(storage, grant.id, patch, async (body) => {
    calls++; originalId = body.requestId;
    assert.deepEqual(Object.keys(body).sort(), ["campaignId", "requestId", "spins"]);
    assert.equal(readCreatorIntent(storage, scope)?.id, body.requestId, "the transport starts only after the UUID has persisted");
    throw new Error("response lost after commit");
  });
  assert.equal(pending.status, "pending");
  const receipt = records.get(`ff:creator-intent:${scope}`)!;
  assert.deepEqual(Object.keys(JSON.parse(receipt)).sort(), ["id", "signature"]);
  assert.ok(!receipt.includes(grant.id) && !receipt.includes("campaign") && !receipt.includes('"spins"'), "the stored value contains neither grant terms nor identifiers");
  assert.deepEqual(await submitGrantEdit(storage, grant.id, { spins: 12 }, async () => { calls++; throw new Error("must not send"); }), { status: "not_sent", reason: "intent_pending" });
  assert.equal(calls, 1, "an uncertain edit cannot be replaced with a different edit");
  assert.equal(records.get(`ff:creator-intent:${scope}`), receipt);

  for (const raw of [null, {}, { ok: true }, { ok: true, requestId: crypto.randomUUID(), grantId: grant.id, replayed: true }, { ok: true, requestId: originalId, grantId: "other", replayed: true }, { ok: true, requestId: originalId, grantId: grant.id, replayed: "yes" }, { error: "forbidden" }]) {
    assert.equal((await submitGrantEdit(storage, grant.id, patch, async (body) => { assert.equal(body.requestId, originalId); return { ok: true, json: async () => raw }; })).status, "pending");
    assert.equal(records.get(`ff:creator-intent:${scope}`), receipt, "malformed or mismatched success cannot erase a retry receipt");
  }
  for (const status of [400, 401, 403, 404, 409, 500, 503]) {
    assert.equal((await submitGrantEdit(storage, grant.id, patch, async () => ({ ok: false, json: async () => ({ ok: true, requestId: originalId, grantId: grant.id, replayed: false, status }) }))).status, "pending");
    assert.equal(records.get(`ff:creator-intent:${scope}`), receipt, "HTTP refusal alone does not fence a possibly delayed earlier write");
  }
  const replay = await submitGrantEdit(storage, grant.id, { campaignId: null, spins: 20 }, async (body) => {
    assert.equal(body.requestId, originalId, "reload/retry and canonical field ordering preserve the operation UUID");
    return { ok: true, json: async () => ({ ok: true, requestId: originalId, grantId: grant.id, replayed: true, grant: { spins: 20 }, spinsRemaining: 20 }) };
  });
  assert.deepEqual(replay, { status: "confirmed", replayed: true }, "stale replay terms and balance are deliberately excluded; the UI must refetch current saved detail");
  assert.equal(readCreatorIntent(storage, scope), null);

  for (const patch of [{}, { spins: Infinity }, { spins: -1 }, { spins: 1.2 }, { amountCents: NaN }, { amountCents: 100_000_001 }, { campaignId: undefined }, { campaignId: "" }, { campaignId: 123 }, { unexpected: true }]) {
    const before: number = calls;
    assert.deepEqual(await submitGrantEdit(storage, grant.id, patch as Parameters<typeof submitGrantEdit>[2], async () => { calls++; throw new Error("must not send"); }), { status: "not_sent", reason: "invalid_patch" });
    assert.equal(calls, before);
    assert.equal(readCreatorIntent(storage, scope), null);
  }
  for (const unavailable of [
    { ...storage, setItem: () => { throw new Error("blocked"); } },
    { ...storage, getItem: () => null, setItem: () => {} },
    { ...storage, getItem: () => { throw new Error("blocked read"); } },
  ]) {
    assert.deepEqual(await submitGrantEdit(unavailable, grant.id, patch, async () => { calls++; throw new Error("must not send"); }), { status: "not_sent", reason: "storage_unavailable" });
  }
  assert.equal(calls, 1, "blocked and silently ignored storage writes prevent all grant fetches");

  const first = await submitGrantEdit(storage, grant.id, patch, async () => ({ ok: false, json: async () => ({ error: "edit_pending" }) }));
  assert.equal(first.status, "pending");
  const firstId = readCreatorIntent(storage, scope)!.id;
  assert.equal(releaseCreatorRequest(storage, scope, { requestId: firstId, kind: "edit", status: "absent" }, firstId, "edit"), "absent");
  assert.equal(readCreatorIntent(storage, scope)!.id, firstId);
  assert.equal(releaseCreatorRequest(storage, scope, { requestId: firstId, kind: "edit", status: "cancelled" }, firstId, "edit"), "cancelled");
  let secondId = "";
  await submitGrantEdit(storage, grant.id, { spins: 12 }, async (body) => { secondId = body.requestId; throw new Error("lost reply"); });
  assert.notEqual(secondId, firstId, "only verified cancellation permits a new edit identity");
  assert.throws(() => releaseCreatorRequest(storage, scope, { requestId: firstId, kind: "edit", status: "committed" }, firstId, "edit"), /receipt_changed/);
  assert.equal(readCreatorIntent(storage, scope)!.id, secondId);

  const late = await submitGrantEdit(storage, grant.id, { spins: 12 }, async (body) => {
    storage.setItem(`ff:creator-intent:${scope}`, JSON.stringify({ id: crypto.randomUUID(), signature: "a".repeat(64) }));
    return { ok: true, json: async () => ({ ok: true, requestId: body.requestId, grantId: grant.id, replayed: true }) };
  });
  assert.equal(late.status, "pending", "a late successful callback cannot release a newer local intent");
  assert.notEqual(readCreatorIntent(storage, scope)!.id, secondId);
  records.clear();
  const noDelete = await submitGrantEdit({ ...storage, removeItem: () => {} }, grant.id, patch, async (body) => ({ ok: true, json: async () => ({ ok: true, requestId: body.requestId, grantId: grant.id, replayed: false }) }));
  assert.equal(noDelete.status, "pending", "a silently ignored storage deletion retains the recovery state");
  assert.ok(readCreatorIntent(storage, scope));
  console.log("grantEditIntent.test: presence-bound patch, exact pricing, durable IDs, lost-reply recovery, terminal cancellation, storage refusal and stale-result isolation passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
