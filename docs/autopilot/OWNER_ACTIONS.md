# Owner actions — what's waiting on you

Last updated 2026-10-23 (evening). Top to bottom = do-first to whenever. The
autopilot adds a line here whenever it gets blocked on you. Nothing you deferred
gets removed until you've done it.

## Status of this session's approvals
- [x] **1a. Redesign Phase 1 onto current code**, done safely. `main` and the live site were
      **not touched**. Instead `main` was merged *into* `dashboard-redesign`, which is now
      today's code + Phase 1 only. Verified: lint, typecheck, 13/13 test files, build, 23/23
      browser journeys, accessibility scan. Vercel builds its Preview on the **test** database.
- [x] **1b. `CONFIRM_EVERYTHING.md`**: skipped as a separate doc. It's the June 30 checklist
      proving GitHub secrets, branch protection, Vercel env vars, and the Supabase setup were
      wired correctly. Its still-useful facts are now in `docs/DEPLOY.md` and this log, and the
      file itself is preserved in the branch archive.
- [~] **1c. Branch cleanup**: half done (see 1 below).
- [x] **1d. Cleanup PR**: opened as Guhlores-Team/fanfunnel#42 (docs + tooling only, no app
      code). To merge: open its Preview, confirm the site behaves as before, check CI is green, merge.
- [x] **2a. Supabase resumed**: confirmed both **ACTIVE_HEALTHY**, both at migration 0038
      (in sync with the code). Prod pages now load in 0.5–1.7s (were 6–21s while paused).

## Running now
- **RD-2: redesign shell (sidebar + top bar)**, started 2026-10-23 in its own cloud session
  ("FanFunnel redesign RD-2" in your Claude Code sessions list). It opens a PR into
  `dashboard-redesign` (never `main`) titled `[autopilot] RD-2: …`. When you're home, open
  that PR's Vercel Preview, click through every section, and check the "needs placement"
  proposals in its description. It stops after RD-2. Nothing merges without you.

## 1. Finish the branch cleanup (5 min, at a computer)
All 21 old branches are **already preserved** in one branch, `archive/branches-2026-10`
(its `ARCHIVE.md` lists every branch + exact commit + a one-line restore command).
Cloud sessions aren't allowed to delete branches (GitHub returns 403), so the delete is yours:

**Option A (terminal, 1 command).** In your local clone:
```bash
git fetch origin
git checkout claude/eager-volta-l8juq7        # or main, once the cleanup PR is merged
scripts/delete-archived-branches.sh           # dry run: should list 21 "archived" branches
scripts/delete-archived-branches.sh --apply   # deletes only branches safely inside the archive
```
**Option B (browser).** github.com/Guhlores-Team/fanfunnel/branches → trash icon on each
branch listed in `docs/BRANCHES.md` sections A, B, C (handoff only), D. Keep `main`,
`dashboard-redesign`, `archive/branches-2026-10`.

**Then (stops branches piling up again):** GitHub → repo **Settings → General → Pull
Requests** → tick **"Automatically delete head branches"**.

End state: `main` (live) · `dashboard-redesign` (redesign in progress) ·
`archive/branches-2026-10` (history) · plus one branch per open PR.
The **test site isn't a branch**: it's Vercel's *Preview* environment + the Supabase
**test** project. Deleting branches can't affect it.

## 2. Dashboards
- [ ] **2b. Local dev is wired to the LIVE database.** Vercel → fanfunnel → Settings →
      Environment Variables → filter *Development*: the 3 Supabase vars point at **prod**
      (`ttlogfmogcccwiraaoae`), so `vercel env pull` / `vercel dev` would read and write live data.
      **Claude already has Vercel access and can fix this in a minute. Just say "fix 2b".**
      Recommended fix: delete those 3 Development vars (local dev then uses safe demo mode;
      put test keys in `.env.local` when you want a real DB). To do it yourself instead:
      1. vercel.com → *fanfunnel* → **Settings** → **Environment Variables**.
      2. Filter by **Development**.
      3. For `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`:
         **⋯ → Remove** (or **Edit** and paste the **test** project's values from Supabase →
         *fanfunnel test* → Project Settings → API).
      4. Don't touch the **Production** or **Preview** rows.
- [ ] **2c. Test DB has no admin user** *(deferred until home)*. Sign up on a Preview URL, then
      in Supabase → *fanfunnel test* → SQL editor:
      `update public.profiles set role='admin' where email='you@…';`
      (Supabase is connected now, so Claude can run that for you once you've signed up.)
- [ ] **2d. Supabase → Authentication → SMTP** *(deferred until home)*. Password-reset emails don't send without it.
- [ ] **Optional:** Supabase has a third, *inactive* project, "SteveGuhlore's Project"
      (`kiuacheatzqoaxjggbrl`, created May 31 just before `fanfunnel`). It looks like an
      abandoned first attempt. Delete it if you agree; Claude won't touch it.

## 3. Hands-on checks *(deferred until home)*
- [ ] **3a. Prod smoke test.** Sign in, save a wheel with 20+ prizes, reload, mint a link,
      spin on your phone, fulfil the win (`e2e/MANUAL-CHECKLIST.md`).
- [ ] **3b. Real-device items** from `e2e/MANUAL-CHECKLIST.md`: sound, haptics, iOS notch,
      QR scan, real sign-up email, webhook to a real endpoint.

## 4. Decisions *(deferred until home; the autopilot skips these until you decide)*
- [ ] **4a. Redesign gaps.** The [parity map](../design/command-center/PARITY_MAP.md) found **78
      current features the design doesn't show** (about half of Analytics: funnel, CRM, heatmap,
      ROI, cohorts; wheel archive/schedule/duplicate; label color/size; fulfilment cancel/notes;
      fan QR + campaign picker; webhooks; admin roles/flags; the agency link). Each needs a home,
      or your explicit OK to drop it. The autopilot proposes placements in each phase PR for you to approve.
- [ ] **4a-2. Notifications.** The only genuinely new behavior in the design. In-app only, or web-push too?
- [ ] **4a-3. Safety steps the design simplifies.** Keep password-to-change-email, typed email to
      delete an account, typed RESET to clear data, Unblock after Block? (Recommended: keep all four.)
- [ ] **4b. Upstash Redis for rate limiting** (shared limits across Vercel instances; costs money).
- [ ] **4c. Terms + Privacy pages.** The fan age gate makes fans agree to Terms that don't exist.
- [ ] **4d. How to run the autopilot**: supervised `/goal` sessions or an hourly scheduled task.
      See [`AUTOPILOT_PROMPT.md`](AUTOPILOT_PROMPT.md).

## Connections & tools (as of 2026-10-23)
| | Status |
|---|---|
| GitHub | ✅ Read, push branches, open PRs. ❌ Delete branches / push tags (cloud-session limit, by design). |
| Vercel | ✅ Projects, deployments, env vars, logs. |
| Supabase | ✅ Connected this session: projects, migrations, advisors, SQL. |
| Chromium / Playwright | ✅ A SessionStart hook (`.claude/hooks/session-start.sh`) installs deps and points Playwright at the preinstalled browser in every cloud session, once the cleanup PR is merged. |
| Neon | ⚠ Connected but unused (FanFunnel's database is Supabase). Safe to disconnect. |
