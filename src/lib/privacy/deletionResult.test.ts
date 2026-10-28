import assert from "node:assert/strict";
import { closeAccountErrorMessage } from "./messages";
import { readFileSync } from "node:fs";
import { ACCOUNT_CLEANUP_PENDING_MESSAGE, deletionResponseState } from "./deletionResult";

assert.equal(deletionResponseState(200, { ok: true }), "complete");
for (const [status, body] of [[202, { pending: true }], [202, { ok: true }], [200, { ok: true, pending: true }]] as const) assert.equal(deletionResponseState(status, body), "pending");
for (const [status, body] of [[500, { ok: true }], [204, null], [200, {}], [200, { error: "db_error" }], [401, {}]] as const) assert.equal(deletionResponseState(status, body), "failed");
assert.match(ACCOUNT_CLEANUP_PENDING_MESSAGE, /not been confirmed deleted/);
assert.doesNotMatch(closeAccountErrorMessage("db_error"), /[Nn]othing was deleted/);
assert.match(closeAccountErrorMessage("storage_cleanup_failed"), /not confirmed/);
for (const file of ["src/components/dashboard/PrivacySecurityCards.tsx", "src/components/admin/AdminClient.tsx"]) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /deletionResponseState\(res.status, d\)/);
  assert.ok(source.indexOf('state === "pending"') < source.indexOf(file.includes("AdminClient") ? 'toast("Account permanently deleted"' : 'window.location.assign("/login?closed=1")'));
}
console.log("deletion UI: explicit completion only; 202, pending bodies and malformed successes preserve account state");
