# Batch-7 builder brief (shared; binding)

You build the findings assigned in your prompt on ONE branch in ONE worktree (named in your prompt).
Base: `orch/fixes` 7cbde12 (= 64000ec + a vercel.json commit that keeps your branch off Vercel Previews; keep it).
The worktree already has `node_modules` (copied); do not `npm ci` unless package-lock changes.
Cost is not a constraint; correctness and completeness are. Build EVERY item in your list unless it is
impossible or wrong, and say so per item in your report. Do not narrow scope silently.

## Read first
- `AGENTS.md` (Supabase auth contract + deploy rules — binding), `docs/handoff/MASTER_TRACKER.md`.
- `node_modules/next/dist/docs/` for ANY Next API (Next 16 — not the Next you know). React 19.
- Your audit reports (paths in your prompt). Each finding has file:line and a proposed fix; the report's
  repro scripts (Playwright) live in the auditor's dir — copy them into your own log dir and reuse them
  as regression checks where they exist.
- The triage file `/tmp/claude-0/-home-user-fanfunnel/318f3258-f870-5536-9e75-5f1a0d75afee/scratchpad/b7merge/TRIAGE.md`
  (context on what other builders own).

## Auth contract essentials
No `user_metadata`/`app_metadata` authz; roles from `profiles` via `is_admin()`/`can_act_for()` (server-side);
service key only via `createServiceClient()` in `src/lib/supabase/server.ts`, never reachable from `"use client"`;
privileged ops through server routes with explicit checks; new server-only RPCs revoked from
public/anon/authenticated; RLS + real policy on every new table (no `using(true)`); SECURITY DEFINER with fixed
`search_path`; a NEGATIVE test for every new authz surface. Global lock order: fan → pass → wheel → prize.

## File ownership (avoid merge conflicts)
Your prompt lists the directories/files you own. Do not edit files owned by another builder; if a fix
truly needs a change there, make the smallest possible edit and list it under "cross-owner edits" in your
report so the merge can be checked. Shared files everyone may touch with small additive edits:
`e2e/run.mjs` (register your journey file: add ONE import + ONE call, nothing else), `e2e/a11y.mjs`
(add states), `.env.example` only if your prompt says so, `supabase/schema.sql` ONLY the DB builder.

## Migrations
Only the DB builder (`gaps/b7-db`) may add a migration, numbered `0073_*.sql`. It keeps
`supabase/schema.sql` and `supabase/migrations_combined.sql` in sync with the repo's tooling (see git log of
those files), regenerates DB types, adds probes to `scripts/db/` wired into `schema-drift-check.mjs`, and
bumps `schema_version()` to 73. Other builders: if your fix needs SQL, write it as a clearly marked
proposal in your report (exact SQL) and build the app side so it works both before and after the SQL lands
where that is possible.

## Tests and copy
Every bug fix gets a regression test (unit test next to the code, or an e2e step in a `e2e/<name>-b7.mjs`
journey file registered in `e2e/run.mjs`, or an a11y state). Never weaken, skip or delete a test; update a
test only when the behaviour it locks was the bug. Copy: apply the rows of the copy table at the end of
`/tmp/claude-0/-home-user-fanfunnel/318f3258-f870-5536-9e75-5f1a0d75afee/scratchpad/b7audit/trust2/REPORT.md`
that touch files YOU own (list which rows you applied). Public text rule: no "buy", "paid", "purchase",
"gamble", "bet", "lottery" in anything a fan sees.

## Verification (builder gate — changed 2026-11-10: NO full verify round per builder)
The shared lock made per-builder full rounds take all night, so the gate before you report is:
1. `npm run lint` and `npm run typecheck` (light, run freely).
2. Full `npm test` and `NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build`, each wrapped in the shared lock
   (`flock /tmp/claude-0/-home-user-fanfunnel/318f3258-f870-5536-9e75-5f1a0d75afee/scratchpad/heavy.lock <cmd>`),
   detached with `setsid nohup … &` and polled, so a restart doesn't kill them.
3. Your own server on YOUR port from that build, then: your new e2e journey file and every existing
   journey that touches files you changed (run the journey functions through a small runner in your log
   dir, or the whole `npm run e2e` under the lock if that is simpler), and `A11Y_ONLY="<substring>"`
   a11y states for the pages you changed. NEVER `playwright install` (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`).
   Kill only your own server (by pgid or socket inode), never `pkill -f next`.
4. If you touched SQL or `scripts/db/**`: drift (`PG_BIN=/usr/lib/postgresql/16/bin node scripts/db/schema-drift-check.mjs`)
   and interplay strict, under the lock.
All four must be clean on your FINAL pushed head. The orchestrator runs the full verify rounds (drift ×2,
interplay, stress, full e2e, full a11y) on the merged branch and sends any failure back to the owner of
the file. A flake is not a root cause — diagnose and fix.

`orch/fixes` moves as branches merge (now: + ci, db/0073, trust). Bring it into your branch with
`git fetch origin orch/fixes && git merge origin/orch/fixes` (a merge commit, never a rebase) before your
final gate, resolve conflicts keeping both sides' intent, and wire your code to the new shapes it brings
(DB shapes: `/tmp/claude-0/-home-user-fanfunnel/318f3258-f870-5536-9e75-5f1a0d75afee/scratchpad/b7build/db/PROGRESS.md`
and `REPORT.md` in the same dir).

The container can restart without warning: commit + push your branch after every meaningful step
(`git push -u origin <your branch>`), and write `PROGRESS.md` in your log dir every ~30 minutes.

## Commits
Imperative messages explaining why, each ending with exactly:
```
Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CsnrjqW2CQm5um63ixPS33
```
No model names anywhere else (code, docs, messages). No new deps without a stated reason. No force push, no
rebase, no bare `git stash`.

## Hard rules
Never push/merge to `main`, `dashboard-redesign` or `orch/fixes`. NEVER use any `mcp__*` tool (they hang on
permission prompts). Never touch remote Supabase (prod `ttlogfmogcccwiraaoae` or TEST `snmcrmhgevfqggxdiomu`)
or Vercel. Don't touch other worktrees. Write only in your worktree and your log dir under
`/tmp/claude-0/-home-user-fanfunnel/318f3258-f870-5536-9e75-5f1a0d75afee/scratchpad/b7build/<your-name>/`.
Never ask the owner for keys or codes. No purchases, no new services.

## Report (concise, as your final message)
Final pushed SHA; per finding ID: built / partly (why) / not built (why); both rounds' numbers (unit files,
drift ×2, interplay checks, e2e pass/total + signals, a11y states/blocking, stress-db, stress-http);
AGENTS.md acceptance answers with file:line for any new authz surface; cross-owner edits; proposed SQL
for the DB builder (if any); owner/lawyer questions you could not resolve.
