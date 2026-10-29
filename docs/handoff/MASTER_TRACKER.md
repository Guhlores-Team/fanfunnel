# Master tracker — everything left before go-live

Single source of truth for "is it done". A row is closed only when its fix is
merged to `dashboard-redesign`, CI is green on that exact commit, it is checked
on TEST/Preview where applicable, and its test exists. Audit IDs (A#) refer to
`COMPLETENESS_AUDIT_2.md` (2026-10-29, at fd71482).

Owner confirmations: Look & feel card seen on Preview (2026-10-29). Admin 2FA enrolled.

## 1. Roadmap stages (prepared source → integrate)
| Item | Migration | State |
|---|---|---|
| RM-7a scratch tickets | 0060 | integrating (branch `stage/0060-scratch`) |
| RM-7b personal bingo | 0061 | queued (after 0060) |
| Account-security follow-up | 0062 | queued |
| Ledger operations + 7-path safety overlay | 0063 | queued (overlay mandatory before first verify) |
| Final hardening (36 paths) | — | queued |

## 2. Audit gaps
| Batch | IDs | State |
|---|---|---|
| 1 | A1 (blocker: fan-report review), A3, A4, A5, A6, A7, A8, A13, A16, A23, A24 | building (branch `gaps/batch-1`, migration 0064 if needed) |
| 2 (after 0061, same code) | A2 wheel-save stock overwrite, A42 cancelled-prize stock | queued |
| 3 | A9, A10, A11, A12, A14, A15, A17, A18, A19, A20, A21, A22, A25, A27, A28, A29, A30, A31, A32, A33, A34, A35, A36, A37, A40, A41 | queued |
| Go-live tooling | A38 TEST→LIVE carry-over script (dry-run first), A39 enforce DB-before-code ordering | queued |
| Stress | A26 load/abuse harness + the 10 scenarios in the audit's stress-test plan | after build-out |

## 3. Verification & acceptance (from TAKEOVER_CHECKPOINT open gaps)
- Two fresh independent security audits + privacy-promise check + outside-attacker pass; fix Critical/High.
- Feature/completeness re-audit after all of the above (expect zero open rows).
- Hosted authenticated feature checks on Preview; installed-phone push (iPhone Home Screen + Android).
- Reward-key backup + TEST restore drill; second-admin recovery drill.
- Email settings + authorized delivery tests; TEST cron scheduling and alert receipt.
- Old Preview retirement (owner approval).
- Owner acceptance on Preview via `e2e/MANUAL-CHECKLIST.md`, then go-live per `docs/GO_LIVE.md` only on the owner's explicit "go".
