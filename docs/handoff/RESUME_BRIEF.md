# Concise takeover brief

> **Superseded by [MASTER_TRACKER.md](./MASTER_TRACKER.md) (2026-11-04).** This brief was
> refreshed on 2026-11-04 and only points at the tracker; where they disagree, the tracker
> wins. The 2026-10-29 pause brief ("next is 0060") is history: 0060–0066 are built.

Read `AGENTS.md`, this brief, `MASTER_TRACKER.md`, then `HANDOFF.md` (§1–§3 refreshed the
same day). This is a saved context summary; verify Git and provider state before acting.

- **Go-live candidate: `orch/fixes`** — migrations 0001–0066, the final hardening and audit
  batch 3 (merged 2026-11-04; docs reconciled at 7bea8ac).
- **Batch 4 in flight** off 7bea8ac: `gaps/b4-db` (0067), `gaps/b4-seats` (agency seats on
  campaigns), `gaps/b4-stress` (load/abuse harness), `gaps/b4-qa` (docs, public-page copy,
  exploratory QA). They do not deploy Previews.
- **`dashboard-redesign`** (draft PR #78, head 8bf5c4c) has 0001–0061 and the game-switching
  UX. Nothing new goes on it until the owner says "go".
- **TEST database `snmcrmhgevfqggxdiomu` is at 0061.** Production `ttlogfmogcccwiraaoae` is
  untouched. Never push/merge `main`, never write Production.
- Stable TEST Preview:
  https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app
- **Waiting on the owner's "go"** → `orch/fixes` into `dashboard-redesign`, 0062+ onto TEST
  (DB before code), exact-SHA Preview deploy, then owner acceptance with
  `e2e/MANUAL-CHECKLIST.md` (§19 covers games, campaigns and per-fan links).
- Each change needs two full local rounds (HANDOFF §5), exact-SHA CI and, for DB changes, real
  TEST history/types/runtime checks. No autonomous Production release is authorized.
- Open gates (tracker §3): two fresh security audits, hosted feature checks, installed-phone
  push, key backup/TEST restore, second-admin recovery, email and cron checks, Production
  env vars (`REWARD_ENCRYPTION_KEY`, `REWARD_CODE_FINGERPRINT_KEY`, `CRON_SECRET`).
- Admin 2FA is already enrolled. Never ask for API keys or authenticator codes in chat. Give
  the non-technical owner one step at a time with clickable links.
- **At 3% weekly usage remaining, stop starting work and follow the saved checkpoint
  procedure** (`TAKEOVER_CHECKPOINT.md`). The agent cannot see the meter; the owner must flag it.

Suggested next-agent instruction: "Continue FanFunnel from `orch/fixes`. Read AGENTS.md and
docs/handoff/MASTER_TRACKER.md first. Finish and merge the batch-4 branches, then wait for the
owner's go before anything reaches `dashboard-redesign`, TEST or Production."
