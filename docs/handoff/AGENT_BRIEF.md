# FanFunnel agent brief (shared rules for every implementation agent)

Repo: GitHub `Guhlores-Team/fanfunnel` (Next.js 16 + React 19 + Tailwind 4 + Supabase). You work in your own git worktree.
The owner approved parallel work on new branches with their own PRs. Your prompt names YOUR item, YOUR branch, YOUR base and YOUR port.

## Binding rules
- Read `AGENTS.md` first (Supabase auth contract + preview-before-prod). It is binding. "This is NOT the Next.js you know": check `node_modules/next/dist/docs/` before using unfamiliar Next APIs.
- **Never merge anything. Never push to `main`, `dashboard-redesign`, or any branch except your own.** Don't delete branches. Don't force-push.
- Never touch the prod Supabase project or the live site (`fanfunnel.vercel.app`). Don't use Supabase/Vercel MCP tools at all.
- Don't change auth, RLS policies, grants, the spin engine's fairness logic, or API contracts unless your item IS that change. In that case answer AGENTS.md's four acceptance questions in the PR with file:line evidence.
- No new dependencies unless unavoidable (then justify it in the PR).
- Never weaken, skip or delete a test or CI check. Updating a selector so the test still asserts the same thing is fine.
- Bug fixes: write a failing test first (unit tests are `src/**/*.test.ts`, run by `npm test`; copy the style of `src/components/dashboard/packHelpers.test.ts`), then the minimal fix. Fix BOTH the mock data layer (`src/lib/data/mock.ts`) and the Supabase path when both exist.
- `verify-first` items: first prove the problem still exists on your base, with file:line. If it's already fixed, make the PR a short docs-free note with evidence (an empty-diff PR isn't possible, so instead add or strengthen a regression test that locks the fix in), and say so.
- DB changes: new numbered migration in `supabase/migrations/`, mirrored into `supabase/schema.sql` + `supabase/migrations_combined.sql` (the sqlSync test enforces it). RLS on any new table. Before you pick a number, run `git fetch origin '+refs/heads/*:refs/remotes/origin/*'` and use one higher than the highest number on ANY remote branch. Don't apply migrations yourself (CI's `supabase` job applies them to the TEST project on PRs). Say in the PR that the migration must reach prod before or at merge.
- `src/lib/data/index.ts` contains a NUL byte: use `grep -a` / `awk`, not plain grep.
- Planning docs live only on `origin/claude/eager-volta-l8juq7` (`git show origin/claude/eager-volta-l8juq7:<path>`): `docs/autopilot/BACKLOG.md`, `docs/autopilot/AUTOPILOT_PROMPT.md`, `docs/RELEASE_CHECKLIST.md`, `docs/design/command-center/{README.md,PORTING_CHECKLIST.md,PARITY_MAP.md,FanFunnel Command Center.dc.html,FanFunnel Mobile.dc.html,screenshots/*.png}`. **Never commit those docs on your branch.** Extract PNGs to /tmp to view them.

## Setup
1. `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`, then `git checkout -b <your-branch> origin/<your-base>`.
2. `npm install --no-audit --no-fund`.
3. Playwright (never run `playwright install`):
   `git show origin/claude/eager-volta-l8juq7:.claude/hooks/session-start.sh > /tmp/ss-$PORT.sh && CLAUDE_CODE_REMOTE=true CLAUDE_PROJECT_DIR=$PWD CLAUDE_ENV_FILE=/tmp/pwenv-$PORT bash /tmp/ss-$PORT.sh && source /tmp/pwenv-$PORT`
   (re-`source /tmp/pwenv-$PORT` in every new shell before e2e).
4. **CI fix (branches based on `main` only):** `ubuntu-latest` is now 26.04, where Playwright 1.60 can't install Chromium. Port commit `50ea619` as its own commit: `git show 50ea619 -- .github/workflows | git apply` (only those two workflow files). Redesign branches already have it.

## Verify before every push (all must pass, report real output)
`npm run lint` · `npm run typecheck` · `npm test` · `NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build` · then
`NEXT_PUBLIC_ENABLE_DEBUG=1 nohup npx next start -p $PORT > /tmp/next-$PORT.log 2>&1 &` and
`E2E_BASE_URL=http://localhost:$PORT npm run e2e` (must be 23/23, 0 browser signals) and `E2E_BASE_URL=http://localhost:$PORT npm run e2e:a11y` (0 blocking).
Use ONLY your assigned port. Other agents run servers on other ports at the same time. **Stop only your own server**: find its PID with
`for p in $(ps -eo pid=,args= | awk '$2 ~ /^next-server/ {print $1}'); do [ "$(readlink /proc/$p/cwd)" = "$PWD" ] && kill $p; done`.
Never `pkill -f next` (it kills other agents' servers and your own shell). The machine has 4 CPUs shared by several agents, so builds are slower. Be patient and don't start duplicate builds.
UI changes: also take Playwright screenshots at 1440px and 390px, check there's no horizontal overflow at 360px, and look at them.

## Commits
Small, imperative messages. Every commit message ends with:
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CsnrjqW2CQm5um63ixPS33
```
Never put a model name anywhere else (code, PR text).

## PR (GitHub MCP tools; load with ToolSearch `select:mcp__github__create_pull_request,mcp__github__update_pull_request,mcp__github__pull_request_read`)
- Push with `git push -u origin <your-branch>`. Open the PR as a **draft** with the base and title from your prompt.
- Body sections, mirroring `.github/pull_request_template.md`:
  - **What & why:** include the verify-first evidence or bug cause with file:line, and the failing-then-passing test.
  - **How to verify on Preview:** numbered real-click steps on the branch's Vercel Preview (test DB).
  - The template's **Tested on Preview** checklist, left unticked except "DB migration (if any)" and "not bringing dashboard-redesign to main", which you can tick when true.
  - **Notes / risk:** CI port note, migrations, anything left out on purpose, open questions for the owner.
- End the body with:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01CsnrjqW2CQm5um63ixPS33
```
- **Leave the PR as a draft.** The orchestrator watches CI, marks it ready, and may send you back to fix CI or review findings. Don't wait for CI yourself.

## Report back (final message, concise)
PR URL · branch · what changed (file:line) · tests added · exact local results · anything blocked or needing an owner decision · any NEW bugs you noticed but didn't fix (with file:line).
