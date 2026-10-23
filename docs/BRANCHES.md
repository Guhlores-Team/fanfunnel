# Branch audit — 2026-10-23

The repo had 23 branches besides `main`, all last touched between 2026-05-31 and
2026-07-02. All 41 PRs were merged; none were open. Each branch was checked by
test-merging it into `main` (`git merge-tree`). If `main`'s tree came out
unchanged, every line of the branch is already on `main`.

**Target end state:** `main` + `dashboard-redesign` (until the redesign lands) +
whatever is actively being worked on. Every other branch becomes an
`archive/<branch-name>` tag first, so nothing is lost and any branch can be
restored:

```bash
git push origin archive/<branch-name>:refs/heads/<branch-name>   # restore a branch
```

## A. Already fully on `main` (merge is a no-op) → archive

| Branch | Tip | Landed via |
|---|---|---|
| `claude/wheel-label-readability` | `cfd278b` | PR #40 |
| `claude/security-audit` | `8ce1642` | PR #41 |
| `claude/preview-all` | `3b3df10` | PR #39 (combo of the four below + label work) |
| `claude/branded-error-pages` | `460c100` | PR #39 |
| `claude/chat-poll-flood` | `495c18f` | PR #39 |
| `claude/migration-pipeline-probe` | `b03bfd7` | PR #38 |
| `claude/auto-migrations` | `f76cd6a` | PR #37 |
| `claude/deploy-workflow-rule` | `923f4af` | PR #36 |
| `claude/hex-color-wheel-crash-x85m5t` | `a6a2a17` | PRs #2–#24, #26, #33 (long-lived dev branch) |
| `fix/security-backlog` | `4908f78` | ancestor of `main` |

## B. Merged by PR, then superseded by later work on `main` → archive

These conflict with `main` only because `main` kept improving the same lines.
Their features are on `main`.

| Branch | Tip | Landed via | Evidence on `main` |
|---|---|---|---|
| `claude/wheel-label-fit` | `b824189` | PR #39 | wheel labels later rewritten by PR #40 |
| `claude/wheel-label-size` | `9cdf03f` | PR #39 | `supabase/migrations/0037_wheel_label_size.sql` |
| `claude/forgot-password` | `f3bd0fd` | PR #39 | `src/app/forgot-password/`, `src/app/reset-password/`, `src/app/auth/callback/` |
| `claude/harden-wheel-save` | `3fea77b` | PR #35 | `docs/SUPABASE_AUTH_CONTRACT.md`, auth contract in `AGENTS.md` |
| `claude/wizardly-dijkstra-gx9xg3` | `ee7ae69` | PRs #25, #27, #34 (squash) | PR #34 head = branch tip |
| `desloppify-api` | `0034b17` | PR #34 | `src/lib/api/handler.ts`, `src/lib/api/validate.ts` |
| `desloppify-components` | `3209db4` | PR #34 | `src/components/ui/Modal.tsx`, `src/lib/hooks/*` |
| `desloppify-infra` | `2861a94` | PR #34 | `docs/archive/`, `typecheck` script, scaffold SVGs removed |

## C. Has work that is NOT on `main` → keep / fold in

| Branch | Tip | What's unique | Plan |
|---|---|---|---|
| `dashboard-redesign` | `1c8a16a` | Redesign **Phase 1**: elevation tokens (`--s1/--s2/--hair/--lift`), `readableInk()` fix for the 3.52:1 white-on-brand contrast defect, focus ring (`globals.css`, `theme.ts`, `theme.test.ts`); `docs/dashboard-redesign/TEAM_CHECKLIST.md` | Becomes the base of the redesign port. Its only conflict with `main` is `supabase-migrations.yml`, where `main`'s copy is newer. |
| `claude/fanfunnel-handoff-dwgt2m` | `6a2692d` | `CONFIRM_EVERYTHING.md`: the 2026-06-30 infra verification (secrets, branch protection, Vercel env scoping, Supabase health, migration-pipeline proof, open items) | Move into `docs/`, then archive. Clean merge. |

## D. Pre-history → archive (only copy)

`main`'s history restarts at 2026-06-12 (PR #4). These two branches are the
only record of the original build, from 2026-05-22 to 2026-06-09. Their
content was later rebuilt on `main`. Archive them, never delete them outright.

| Branch | Tip | Contents |
|---|---|---|
| `claude/phase-3-polish-bugs-MICSm` | `f2cfa09` | v1 build through Phases 3–5 + realtime chat (PR #1) |
| `claude/creator-spin-wheel-game-WAB9p` | `bf9192c` | v1 foundation, admin panel, `scripts/walkthrough.js` Playwright harness |
