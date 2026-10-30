# Legacy canary bootstrap boundary — SOURCE-ONLY assessment

No TEST/project request, key-file read, key value, hosted mutation, new implementation or frozen-source change was made for this assessment. Root reports a protected private copy of the original0057 encryption key, stable fingerprint key and original-generation provenance; that statement is an input to this plan, not an owner-backup attestation by this agent.

## Definite behavior from final0063 source

`supabase/migrations/0063_operational_integrity.sql:194` refuses every first initialization when **any** erased `prize_reward_codes` row exists. It does so before checking the live encrypted row count. The new four-argument gateway/context does not change that rule. `initializeCanaryForAdmin` validates every bounded live payload/code fingerprint before invoking SQL, but a successful live scan still cannot bypass the tombstone check.

Thus, if the actual TEST state is no anchor + any tombstones, automatic bootstrap remains missing and explicit admin init returns `recovery_required` indefinitely. This is a conservative enrollment gap, not a recoverable old anchor: no old canary ever existed.

The application still starts. `src/lib/operations/startup.ts:14` is once-per-instance, catches failures and has a five-second outer deadline; it does not throw to stop the server. Correct existing reward keys still serve existing decryptable inventory. Startup writes/redacts the missing-canary health failure.

Authenticated retention does **not** become a no-op: `src/app/api/cron/retention/route.ts:44` invokes operational checks after retention cleanup, still processes durable storage work, then returns503 when health is not ok. `runOperationalChecks` requires a healthy canary. The prepared scheduler's explicit200/healthy credential probe therefore refuses activation in this state. A503 is honest failed health, not evidence that cleanup/storage was untouched.

## Do not assume fixture tombstones survive cleanup

0057 defines `prize_reward_codes.prize_id` and `.creator_id` with ON DELETE CASCADE (`0057_instant_rewards.sql:45`–`:48`). Its consumed tombstone survives **fan** erasure while creator/prize remain, preserving fingerprint non-reuse; deletion of that temporary creator/prize removes the owned code rows through the existing cascade.

The current runtime fixture registers every created Auth user, then deletes those users in its finally cleanup (`scripts/security/rls-runtime-test.mjs:944` onward); cleanup failures fail the run. Consequently, successful cleanup should remove the fixture creators' code tombstones. It is not justified to infer persistent TEST tombstones merely because the runtime test exercised delivery/erasure. Failed cleanup, persistent manual test creators, or other historical activity could still leave them. We have not queried actual counts.

There is another important limit: the RLS erasure fixture at`:756`–`:770` uses an unkeyed synthetic SHA256 fingerprint and deliberately synthetic SQL ciphertext, not the real application HMAC/AES pipeline. Those rows cannot prove either original key. They are SQL-contract fixtures, not historical cryptographic anchors. The real function in `src/lib/rewards/crypto.ts:85` computes HMAC-SHA256 over the JSON tuple `[version marker, creator ID, prize ID, code]`. A known fixture label or new current-key roundtrip is not equivalent evidence.

## Strict decision gate

After root authorizes a narrowly scoped read-only TEST check, collect only counts, anchor presence, key-version counts, registered fixture/cleanup provenance and a bounded inventory/tombstone digest. Do not expose keys, real codes, raw ciphertext, fingerprints, TOTP or fan bearer links in reports.

- No tombstones and no encrypted inventory: existing atomic empty bootstrap is sufficient; keep its actual empty-inventory proof and key configuration checks.
- No tombstones but surviving encrypted inventory: existing explicit admin initialization is sufficient after truthful backup prerequisites; all payloads and code fingerprints must validate, and its full-scan digest CAS must pass.
- Any tombstones without an anchor: stop the normal initializer/scheduler activation. Do not delete history, disable the immutable trigger, insert a canary generated merely from the current unverified environment, fake a restore, or add an unchecked allow-tombstones flag.

## Recommended exceptional enrollment if genuinely needed

Use a separately reviewed, one-time **original-key enrollment**, not a permanent weakening of ordinary initialization. The most conservative design retains the normal initializer unchanged and creates the first immutable anchor from independently trusted original key material through an audited privileged operation. The execution mechanism (approved DB-owner enrollment or a narrowly scoped one-time administrative permit) needs root's explicit design review before implementation.

Required evidence and bounds:

1. Owner confirms a secure owner-controlled copy/restore prerequisite. The operator's mode0600 file does not establish that the owner has backed it up; do not tick the UI attestation on their behalf.
2. Establish original-generation provenance for **both** original keys and exact key version, including whether version1 ever used the encryption-key fallback for fingerprinting. Record known rotation/selection history. A file of unknown origin or valid key length is insufficient. If original identity/history is not established, leave enrollment blocked.
3. Privately seal the existing public fixed canary using the trusted original encryption key/version and compute its stable fingerprint with the trusted original fingerprint key. This is an original-key challenge/first anchor, not a newly invented inventory receipt. Do not print/save plaintext keys or real reward codes; the sealed challenge stays in a protected operator/server transport.
4. Verify all surviving bounded ciphertext and real code fingerprints using that original material. Failure, unsupported versions, changed inventory, unknown/unverifiable live rows or unexplained key history blocks enrollment. Do not automatically erase or financially repair synthetic/corrupt leftovers.
5. Preserve **every** tombstone/fingerprint/non-reuse row exactly. Include all live inventory and erased-row metadata in an exact reviewed snapshot count/digest. Historical erased values that cannot be reconstructed remain explicitly unverified; original-key provenance is the evidence for the anchor. Never label synthetic SHA fixtures as HMAC verification.
6. Require explicit audited operator/owner authorization, with the real administrative assurance/receipt where the chosen mechanism uses app authority. Pin the TEST project, exact reviewed source/Preview and approved actor. Acquire the existing admin/inventory fences in their established order; assert anchor absence; CAS the entire approved live+tombstone snapshot; insert only that absent immutable original-key anchor and a redacted audit receipt in the same transaction. Concurrent changes or any existing anchor abort. No permanent role grant, replacement path, history rewrite, data wipe or new financial promise is allowed.
7. The current application must then decrypt/check that original-key anchor and pass diagnostics. If deployed keys differ, health must be **mismatch**, not green. Restore the original configuration through the secure path and redeploy; do not replace the anchor. A successful real manual check clears the prior failure latch. Only then prove authenticated maintenance200 and later an actual scheduled HTTP/application completion.

A known historical **real** HMAC tuple can independently verify the fingerprint key, and real authenticated historical ciphertext can verify an encryption key. Neither an unkeyed SQL fixture fingerprint nor a fresh challenge produced only with the current keys proves original identity. With erased-only inventory, trusted independently preserved original key material/provenance is the essential predecessor evidence. If that evidence or the owner prerequisite is unavailable, report the rollout blocker; there is no cryptographic way to reconstruct erased unknown plaintext or infer the old key from a fingerprint alone.

This plan does not attest the owner's backup, current TEST counts, deployed key equality, historical HMAC consistency or successful enrollment. It authorizes no hosted action by itself. Original0063 and scheduler freezes remain unchanged; normal fail-closed health/scheduler behavior is retained until the evidence-backed one-time decision is reviewed.
