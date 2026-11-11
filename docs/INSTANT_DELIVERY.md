# Instant delivery (0057)

Creators can deliver a private link, text, or one-use code immediately after a
win. Creator lists show masked code hints and stock; fans can open their own
delivered values again from their private win history. Opening a value records
a view. Public share and verification pages never contain delivered values.

## Preview configuration

The following Sensitive, server-only variables were configured for Preview,
not Production. Never prefix them with `NEXT_PUBLIC_` or copy their values into
chat, source, logs, or screenshots.

- `REWARD_ENCRYPTION_KEY`: base64 of 32 independent random bytes; encrypts values
  with AES-256-GCM, a random IV and the creator ID as associated data.
- `REWARD_CODE_FINGERPRINT_KEY`: a separate 32-byte base64 key for identifying
  duplicate codes, including consumed codes whose plaintext has been erased.

Secure owner-controlled key backup is still required before uploading real
rewards. Environment configuration is not a disaster-recovery plan. Losing the
encryption key makes stored rewards unreadable. Never rotate the fingerprint
key: erased code tombstones cannot be recalculated from plaintext.

The default encryption key version is 1. Changing the key/version requires an
explicit re-encryption and restore plan; changing an environment variable alone
does not migrate stored ciphertext. Production must use separate keys when an
explicitly approved release reaches that environment.

## Integrity and privacy

Instant finalization atomically records the spin, code allocation, immutable
encrypted receipt and fulfilled redemption. Retrying the same spin UUID returns
the same receipt. Code identity is unique per creator/prize across uploads and
consumed history. Saving a wheel's prize set is transactional and cannot delete
reward inventory on a partial failure.

Fan receipt reads require the private link, recheck the engagement gate and
record the view before returning plaintext. History is paginated independently
of the recent-win display. Data exports include only explicit reward metadata,
with failed/truncated sections disclosed. Fan erasure clears delivered secrets
and hints, preserving anonymous financial records and non-reusable consumed
code tombstones. Auto-delivered redemptions cannot be reopened or scheduled.

## Remaining integration boundary

0057 does not make the older credit claim, seed rotation and pity writes one
transaction. An unknown finalization response stays pending and must not be
blindly refunded or replaced with a new paid spin. The durable attempt ledger
and atomic credit/seed/pity/focus transaction are required in 0059 before the
complete roadmap is accepted. Preview is a test environment throughout this work.

Durable in-flight upload/account-deletion recovery belongs to 0058. Automatic
TEST retention scheduling, key backup/restore rehearsal and final independent
security audits remain open operational work; no scheduled TEST cleanup is
claimed active merely because the retention route exists.
