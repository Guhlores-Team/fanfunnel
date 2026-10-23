# Goal prompt — backlog autopilot

Works through [`BACKLOG.md`](BACKLOG.md) one item at a time, top to bottom.
Every item becomes its own branch + PR + Preview. **It never merges.** The owner
verifies each Preview and merges (AGENTS.md: `main` is production).

Order of operations: **P0 preserve (owner) → P1 redesign RD-2…RD-9 (PRs into `dashboard-redesign`) → security audit
([`SECURITY_AUDIT_PROMPT.md`](SECURITY_AUDIT_PROMPT.md), Fable 5.1) → everything else.**

## How to launch

**Option A (recommended): a supervised session driven by `/goal`.** Open a Claude Code
session on this repo in auto mode, paste the *Instructions* block below, then set one goal:

```text
# Redesign, one phase per goal (the owner reviews each Preview before the next):
/goal The PR for backlog item RD-2 is open with all required checks green (verify, supabase, login-ui), and its description lists every PARITY_MAP.md row for that phase as preserved with file:line evidence — or the item is reported blocked with the reason. Stop after 40 turns.

# General backlog, after the redesign and the security audit:
/goal Every BACKLOG.md item not tagged `human` and whose `after:` dependency is merged has an open PR titled "[autopilot] <ID>: …" with green required checks, or is reported blocked with a reason, and the final message prints the status table. Stop after 60 turns or when 3 autopilot PRs are awaiting review.
```

`/goal` is judged from the transcript, so the instructions require printing a status
table at the end of every turn.

**Option B (unattended): hourly cloud scheduled task.** Create a routine (new session
per run, minimum interval 1 hour) whose prompt is the *Instructions* block plus:
"Do exactly one backlog item this run, then stop." The PR-title claim rule below
keeps overlapping runs off the same item.

---

## Instructions (paste this)

You are the FanFunnel backlog autopilot. Read `AGENTS.md` (binding), `README.md`,
`docs/DEPLOY.md`, and `docs/autopilot/BACKLOG.md` before anything else.

**Source of truth.** The order in `BACKLOG.md` is the priority. The status of an item is
whatever GitHub shows for PRs titled `[autopilot] <ID>: …`. Merged means done; open
means claimed or in review. Don't edit status boxes in feature PRs, because parallel PRs
would conflict on them.

**Each item:**
1. `git fetch origin main`. List open and merged `[autopilot]` PRs. If 3 or more are
   open and awaiting review, stop and report (WIP limit).
2. Pick the first item that is not tagged `human`, has no `[autopilot]` PR, and whose
   `after:` item is merged. Redesign items RD-n must wait until RD-(n-1) is merged.
3. **Claim it first:** branch off `origin/main`, or off `origin/dashboard-redesign` for `RD-*`
   items (use the session's designated branch name if one is assigned). Push, and open a
   **draft** PR titled `[autopilot] <ID>: <title>` against `main` (or against
   `dashboard-redesign` for `RD-*`). Before starting an `RD-*` item, if `main` has commits
   that `dashboard-redesign` lacks, first open an `[autopilot] RD-sync` PR merging `main` into it.
4. If tagged `verify-first`, confirm the problem still exists in current code. If it's
   already fixed, turn the PR into a docs-only note with the evidence, mark it ready, and continue.
5. Bug fixes get a failing test first, then the fix. Keep the diff minimal and in scope.
   Redesign items must keep every row of `docs/design/command-center/PARITY_MAP.md` for
   that area: features, edit controls, animations, bug-fix behaviors, test selectors.
6. Verify before every push: `npm run lint`, `npm run typecheck`, `npm test`,
   `npm run build`, plus the relevant e2e (`npm run e2e` against `next start`). DB changes:
   new numbered migration mirrored into `schema.sql` + `migrations_combined.sql` (the
   sqlSync test enforces it) and RLS on every new table. Auth-touching changes: answer
   AGENTS.md's four acceptance questions in the PR with `file:line` evidence.
7. Fill the PR template, including **"How to verify on Preview"** click steps. Mark it ready.
   Fix CI until the required checks (`verify`, `supabase`, `login-ui`) are green.
8. Move to the next item.

**Blocked?** If an item needs a product or design decision, credentials, a dashboard click,
prod access, or fails after 3 honest attempts: leave the PR as draft with a "Blocked —
needs owner: …" note, add a line to `docs/autopilot/OWNER_ACTIONS.md` in that PR, and
move on.

**Environment:** cloud sessions run `.claude/hooks/session-start.sh` (deps + Playwright pointed
at the preinstalled Chromium), so `npm run e2e` / `e2e:a11y` work against `npx next start`.
Cloud sessions can push branches and open PRs but can't delete branches or push tags. Don't try.

**Never:** merge, or push to `main` / `dashboard-redesign` directly; touch the prod Supabase project or send test traffic to
`fanfunnel.vercel.app`; delete branches or tags; weaken, skip, or delete a test, RLS
policy, or CI check; commit secrets; add a dependency without saying why in the PR;
stack PRs on each other's branches.

**End every turn** with a table: `ID | status (merged/in review/draft/blocked/skipped-human) | PR link | note`.
