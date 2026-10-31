# Checkpoint — 2026-10-31 (work paused by owner request)

Everything below is committed and pushed to GitHub on the branches named here.
`main` and Production are untouched. The TEST database is at migration **0061**.

## What is where

| Branch | Base | State | Verified |
|---|---|---|---|
| `dashboard-redesign` (PR #78) | — | 0060 scratch, 0061 bingo + interplay fixes, game-switching UX. Live on the stable Preview (8bf5c4c). | Yes: CI green, Preview deployed |
| `orch/fixes` | `dashboard-redesign` 8bf5c4c | + 0062 account security, 0063 operational integrity (with safety overlay), 0064 gaps batch 1, final hardening (incl. 4 flake root-cause fixes). | Yes: two full local rounds at 301ec76 (264/264 unit files, drift ALL PASS ×2 layouts, interplay strict 764, e2e 184/184, a11y 134 states 0 blocking) |
| `gaps/b3-ui` | 301ec76 | Batch 3 UI: A14, A15, A28, A31, A32, A33, A34, A41, A7/A9/A10, A36, A37, reveal-timing flake. Last commit is a WIP e2e stock fix. | **No** — round 2 e2e had failed; fix unverified |
| `gaps/b3-db` | 301ec76 | Batch 3 DB: migration **0065** (per-fan game pins, A12 indexes, A11 retention, A17 atomic admin claim, A35 cost snapshots, A44 archive lock order, 0063 initializer race, observed-wait probes). SQL commit + WIP app-side commit. | **No** |
| `gaps/b3-app` | 301ec76 | Batch 3 app/security: A20/A43/A21 dead spin path removed, A29, A22 rate limits + static test, A27, A18, A19 agency seat scopes, A30. | **No** — was mid e2e round |
| `gaps/b3-ops` | 301ec76 | Batch 3 ops: A25 CI fails on missing secrets, A39 DB-before-code gate, A38 carry-over tool, A40 docs/tracker refresh, ops DB contract test in CI. | **No** — was starting round 1 |

All five non-`dashboard-redesign` branches are listed in `vercel.json`
`git.deploymentEnabled` as `false`, so pushing them builds no Preview. GitHub
workflows run only on `main` pushes and pull requests, so pushing them runs no
CI and touches no database.

## To resume

1. For each `gaps/b3-*` branch: review the WIP commits, finish the items, run
   two full local rounds (lint, typecheck, `npm test`, debug build, drift ×2
   layouts, `INTERPLAY_STRICT=1` interplay, `node --check`, fresh-server e2e +
   a11y). Fable credits were exhausted on 2026-10-31; b3-db and b3-app were
   continuing on Opus.
2. Merge into `orch/fixes` in this order: `b3-db` (0065), `b3-app` (may add
   0066), `b3-ui`, `b3-ops`. Re-verify the combination twice.
3. With the owner's explicit "go": push `orch/fixes` to `dashboard-redesign`.
   CI applies 0062+ to TEST (DB before code), then deploy that exact SHA to the
   stable Preview. Note: after 0062 an admin with an enrolled authenticator must
   enter its code for dashboard access.
4. Then: stress round (A26 + load), two independent security audits, final
   re-audit, owner steps (push on installed phone, key backup + restore drill,
   second admin, email checks), owner acceptance, LIVE release per GO_LIVE.md.

## Waiting on the owner

- Results of the four Preview tests (wrong-game fix, campaign game picker, fan
  drawer "This link plays", bingo).
- "Go" to push 0062–0064 + final hardening to TEST and the Preview.
- Optional: Fable credits for the final security audits (Opus otherwise).

## Notes

- Production env lacks `REWARD_ENCRYPTION_KEY`/`REWARD_CODE_FINGERPRINT_KEY`
  (Preview has them); needed at go-live (GO_LIVE §4).
- Five stray log files sit in the container root (`/check.log` etc.); harmless.
