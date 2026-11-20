import assert from "node:assert/strict";
import { importRequestHash, normalizeImportRows } from "@/lib/imports/batch";
import { mockDeleteFan, mockImportFans, mockListFans } from "./mock";
import { mockFocusState } from "./mockFocus";
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const rows = normalizeImportRows([{ name: "Private import A", spins: 3, amountCents: 100 }, { name: "", spins: 2 }, { name: "Private import B", spins: 5, amountCents: 250 }]);
  const id = crypto.randomUUID(), hash = await importRequestHash(rows), before = mockListFans().length;
  const first = mockImportFans(id, hash, rows); assert.equal(first.status, "imported"); if (first.status !== "imported") throw new Error("fixture");
  check("only valid import rows create business records", mockListFans().length === before + 2 && first.items[1].error === "missing_name");
  const second = mockImportFans(id, hash, rows); assert.equal(second.status, "imported"); if (second.status !== "imported") throw new Error("fixture");
  check("repeated batch creates no new fans or grants", mockListFans().length === before + 2 && second.replayed && JSON.stringify(second.items) === JSON.stringify(first.items));
  const persisted = JSON.stringify([...mockFocusState().imports.values()]);
  check("batch ledger contains no names or raw pass tokens", !persisted.includes("Private import") && first.items.every(item => !item.token || !persisted.includes(item.token)));
  const changed = normalizeImportRows([{ name: "Changed", spins: 100 }]);
  check("same batch refuses different normalized payload", mockImportFans(id, await importRequestHash(changed), changed).status === "conflict" && mockListFans().length === before + 2);
  mockDeleteFan(first.items[0].fanId!);
  const erased = mockImportFans(id, hash, rows); assert.equal(erased.status, "imported"); if (erased.status !== "imported") throw new Error("fixture");
  check("deleted row is a gone tombstone, surviving rows never reimport", erased.items[0].error === "gone" && !erased.items[0].token && erased.items[2].token === first.items[2].token && mockListFans().length === before + 1);
  check("erasure removes deleted identities from batch ledger", !JSON.stringify([...mockFocusState().imports.values()]).includes(first.items[0].fanId!));
  const state = (globalThis as unknown as { __ffStore: { grants: unknown[] } }).__ffStore;
  const count = mockListFans().length, grants = state.grants.length;
  const batch = crypto.randomUUID(), rollbackRows = normalizeImportRows([{ name: "Rollback first", spins: 1 }, { name: "Rollback second", spins: 1 }]);
  let pushes = 0; const originalPush = state.grants.push.bind(state.grants);
  state.grants.push = (...values: unknown[]) => { if (++pushes === 2) throw new Error("write unavailable"); return originalPush(...values); };
  const failed = mockImportFans(batch, await importRequestHash(rollbackRows), rollbackRows);
  check("unexpected failure rolls back the whole valid subset", failed.status === "unavailable" && mockListFans().length === count && state.grants.length === grants && !mockFocusState().imports.has(batch));
  const retried = mockImportFans(batch, await importRequestHash(rollbackRows), rollbackRows);
  check("same identity safely retries a wholly rolled-back batch", retried.status === "imported" && mockListFans().length === count + 2);
  console.log(`mock import batches: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
