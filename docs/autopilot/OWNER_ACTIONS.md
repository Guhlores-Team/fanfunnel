# Owner actions — what's waiting on you

Last updated 2026-10-23. Top to bottom = most to least urgent. The autopilot adds a
line here whenever it gets blocked on you.

## 1. Approvals (Claude was stopped by the permission system, by design)
Reply in the session with "approved" plus the item numbers (e.g. "approved 1a 1b 1c").

- [ ] **1a. Bring the redesign's Phase 1 onto current `main`** (backlog RD-1). This merges
      the `dashboard-redesign` branch (tokens + white-on-pink contrast fix) into the redesign
      work so every bug fix since June carries over. It was blocked as a "production deploy"
      step, because AGENTS.md says that branch stays off `main` until you approve it.
      Nothing reaches prod until you verify its Preview and merge.
- [ ] **1b. Fold `CONFIRM_EVERYTHING.md` into `docs/`.** It's the June 30 infra verification
      record, only on branch `claude/fanfunnel-handoff-dwgt2m`. Blocked as "modify shared resources".
- [ ] **1c. Branch cleanup.** Archive 22 branches as `archive/<name>` tags, then delete the
      branches (restorable with one command). Keeps `main`, `dashboard-redesign`, and the
      working branch. Evidence for each branch: [`docs/BRANCHES.md`](../BRANCHES.md).
- [ ] **1d. Open a PR for this cleanup** (branch `claude/eager-volta-l8juq7`, docs only:
      README, docs reorg, design bundle, autopilot prompts). Its Preview:
      `fanfunnel-git-claude-eager-volta-l8juq7-easy-simple-sites.vercel.app`.
      Say "open the PR"; you merge it once you've looked.

*To stop these prompts in future:* allow `git merge` / `git push origin` for this repo in
your Claude Code permission settings, or just approve each time.

## 2. Check in dashboards (Claude has no access)
- [ ] **2a. Supabase: are both projects awake?** Free-tier projects pause after about a week idle,
      and it's been ~4 months. Prod `ttlogfmogcccwiraaoae`, test `snmcrmhgevfqggxdiomu`. On
      2026-10-23 the live site answered but slowly (6–21s). If paused, click *Restore*.
      CI's real-Supabase tests and every Preview depend on **test** being awake.
- [ ] **2b. Vercel → fanfunnel → Settings → Environment Variables → *Development*.** The 3
      Supabase vars there are from May 31. If they point at **prod**, repoint them at **test** so
      local dev / `vercel env pull` can't touch live data.
- [ ] **2c. Test DB has no admin user** (as of June 30). Sign up on a Preview, then
      `update public.profiles set role='admin' where email='…';` in the **test** SQL editor.
- [ ] **2d. Supabase → Authentication → SMTP.** Password-reset emails don't send without it.

## 3. Hands-on checks (need a human + real devices)
- [ ] **3a. Prod smoke test.** Sign in, save a wheel with 20+ prizes, reload, mint a link,
      spin on your phone, fulfil the win. (CONFIRM_EVERYTHING Phase 8 / `e2e/MANUAL-CHECKLIST.md`.)
- [ ] **3b. Real-device items** from `e2e/MANUAL-CHECKLIST.md`: sound, haptics, iOS notch,
      QR scan, real sign-up email, webhook to a real endpoint.

## 4. Decisions (the autopilot will skip these until you decide)
- [ ] **4a. Redesign gaps.** The [parity map](../design/command-center/PARITY_MAP.md) found **78
      current features the design doesn't show** (about half of Analytics: funnel, CRM, heatmap,
      ROI, cohorts; wheel archive/schedule/duplicate; label color/size; fulfilment cancel/notes;
      fan QR + campaign picker; webhooks; admin roles/flags; the agency link). Each needs a home,
      or your explicit OK to drop it. The autopilot will propose placements in each phase PR for
      you to approve. Skim §2 when convenient.
- [ ] **4a-2. Notifications.** Of the design's "mocked" behaviors, only notifications/web-push
      is genuinely new work (the rest already exists). In-app only, or web-push too?
- [ ] **4a-3. Safety steps the design simplifies.** Keep the current friction: password to
      change email, typed email to delete an account, typed RESET to clear data, Unblock after
      Block. Recommended: keep all four.
- [ ] **4b. Upstash Redis for rate limiting** (shared limits across Vercel instances). It costs
      money; the code already supports it via env vars.
- [ ] **4c. Terms + Privacy pages.** The fan age gate makes fans agree to Terms that don't exist.
      Needs your copy, or a lawyer-approved template.
- [ ] **4d. How to run the autopilot**: supervised `/goal` sessions (recommended to start) or
      an hourly unattended scheduled task. See [`AUTOPILOT_PROMPT.md`](AUTOPILOT_PROMPT.md).

## Done in this session (for the record)
- Audited all 23 branches. Nothing is lost: every one is on `main`, superseded, or listed above.
- `main` is healthy: lint, typecheck, 13/13 test files, build all pass; CI green; prod deploy READY;
  zero runtime errors in the last 7 days.
- Saved the Claude Design export into `docs/design/command-center/`. Standalone Claude Design
  closes Dec 14, 2026.
- New README homepage, docs consolidated under `docs/`, ordered backlog + goal prompts in `docs/autopilot/`.
