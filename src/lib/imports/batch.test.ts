import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalImportJson, importRequestHash, normalizeImportRows } from "./batch";
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
async function main() {
  const rows = normalizeImportRows([{ name: ' Fan "A" 😃 ', spins: "2", amountCents: 100 }, { name: "", spins: 1 }, { name: "Decimal", spins: 1.5 }, { name: "Huge", spins: 1_000_001 }, { name: "Bad money", spins: 1, amountCents: "x" }, { name: "Huge money", spins: 1, amountCents: 100_000_001 }, { name: "Refund", spins: -3, amountCents: -50 }]);
  check("row order, trimmed names and existing numeric normalization are preserved", rows[0].name === 'Fan "A" 😃' && rows[0].spins === 2 && rows[0].amountCents === 100 && rows[6].spins === 0 && rows[6].amountCents === 0);
  check("invalid slots are explicit and cannot carry any economic credit", rows.slice(1, 6).map(row => row.error).join() === "missing_name,invalid_spins,spins_too_large,invalid_amount,amount_too_large" && rows.slice(1, 6).every(row => row.spins === 0 && row.amountCents === 0));
  check("canonical slots retain all null fields", rows[0].campaignId === null && rows[0].wheelId === null && rows[0].error === null);
  const fixture = '["fan-import-v1",[{"amountCents":100,"campaignId":null,"error":null,"name":"Fan \\"A\\" 😃","spins":2,"wheelId":null}]]'.replaceAll('\\\\"', '\\"');
  const canonical = canonicalImportJson(["fan-import-v1", [rows[0]]]);
  check("canonical hashing preserves Unicode, quotes, nulls and exact array order", canonical === fixture);
  const digest = await importRequestHash([rows[0]]);
  check("WebCrypto binding agrees with the independently hashed exact canonical fixture", digest === createHash("sha256").update(fixture).digest("hex"));
  check("object key insertion order cannot change import identity", canonicalImportJson({ z: 1, a: null }) === canonicalImportJson({ a: null, z: 1 }));
  const changed = [{ ...rows[0], spins: 3 }];
  check("economic edits change the binding", await importRequestHash(changed) !== digest);
  check("row reordering changes the binding", await importRequestHash([rows[0], rows[6]]) !== await importRequestHash([rows[6], rows[0]]));
  check("skipped rows remain bound to the complete batch", await importRequestHash(rows) !== await importRequestHash(rows.filter(row => !row.error)));
  check("names remain bounded and primitive invalid inputs remain errors", normalizeImportRows([{ name: "x".repeat(100), spins: 0 }])[0].name.length === 80 && normalizeImportRows([null, 5, []]).every(row => row.error === "missing_name"));
  console.log(`import batch normalization: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
