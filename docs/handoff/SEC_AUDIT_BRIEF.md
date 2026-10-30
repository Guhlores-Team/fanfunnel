# SEC-AUDIT brief (shared by both auditors)

The full audit spec is `docs/autopilot/SECURITY_AUDIT_PROMPT.md` on `origin/claude/eager-volta-l8juq7`. Read it with
`git show origin/claude/eager-volta-l8juq7:docs/autopilot/SECURITY_AUDIT_PROMPT.md`. Its attacker models, surface list,
rules of engagement and finding format bind you. Adaptations by the orchestrator, which override the spec where they differ:

- **Target:** `origin/dashboard-redesign` at its current head. That is what will ship. It includes the redesign plus
  migrations 0039–0044. Work in your own worktree: `git fetch origin dashboard-redesign && git checkout -B <your-branch> origin/dashboard-redesign`.
- **Output:** do NOT edit BACKLOG.md, commit, push or open a PR. Write your partial report to
  `docs/handoff/sec/<your-part>.md`, in the
  spec's finding format (ID placeholder `SEC-?`, severity, attacker model, exploit scenario, file:line evidence, safe PoC,
  fix, effort), plus a **verified-safe list** with evidence. The orchestrator merges the two parts, verifies every
  Critical/High finding, and commits the final `docs/security/AUDIT-2026-10.md`.
- **Never** send traffic to production (`fanfunnel.vercel.app`) or the prod Supabase project (`ttlogfmogcccwiraaoae`).
  Dynamic testing is allowed only against:
  - a local build in mock mode (`npm run build && npx next start -p <your port>`);
  - a local Postgres cluster built from the migrations: `PG_BIN=/usr/lib/postgresql/16/bin`, see
    `scripts/db/schema-drift-check.mjs` (`--keep` keeps the cluster) and `scripts/db/README.md`. Use this to call RPCs
    as `anon` / `authenticated` (`set role`, `request.jwt.claims`).

  You have NO Supabase or Vercel tools. Do not try to reach any remote project.
- Do not modify application code, migrations or data. Your worktree is scratch, so throwaway probe scripts go in the
  scratchpad `sec/` folder.
- Port discipline: use only your assigned port and stop only your own server (match the process cwd to your worktree).
- No model names in anything you write. If you find something **Critical and exploitable today**, put it at the very top
  of your report.
- Context that is already known (verify it, don't just repeat it):
  - Release checklist evidence: `.../scratchpad/rd8/RELEASE_CHECKLIST_EVIDENCE.md`.
  - The session cookie is `httpOnly:false` on purpose; check whether that is actually safe given the CSP and XSS surface.
  - Rate limiting is in-process unless Upstash env is set (it is not known to be set).
  - Terms/Privacy pages don't exist (owner legal copy).
  - 0044 revoked anon EXECUTE on 19 signed-in-only RPCs. RLS helpers stay anon-callable.
- **Done means:** every route handler / RPC in YOUR scope is accounted for (a finding or verified-safe), and every
  attacker model is considered for your scope. List the route files and RPCs you covered at the end, so coverage can be
  checked.

## Split
- **Part A (`authz.md`, port 3211):**
  - authZ on every `src/app/api/**/route.ts` handler: IDOR, owner checks, `can_act_for`/`is_admin`, suspended,
    unapproved and `is_active=false` accounts, mass assignment;
  - every RLS policy and every SECURITY DEFINER function / RPC, including what each RPC lets a browser-console caller do
    with the anon key, signed out and as a normal creator;
  - auth flows: sign-up, login, approval gate, password reset and email change, the `/auth/callback` `next` redirect,
    `src/proxy.ts`, session cookies;
  - agency/org member scope;
  - the AGENTS.md four-question acceptance check, with file:line evidence.
- **Part B (`app.md`, port 3212):**
  - spin integrity and money paths: double-spend races, `claim_spin`, grants and edits, referrals, happy hour,
    provably-fair seed/nonce, stock;
  - fan-token secrecy: Referer, logs, share cards, OG images, the debug console, analytics, error messages; token
    entropy and enumeration;
  - injection and XSS: prize labels, chat, taglines, display names, avatar upload sniffing and SVG, webhook payloads,
    OG rendering, `dangerouslySetInnerHTML`;
  - SSRF in webhooks;
  - CSRF, clickjacking, headers, CSP and CORS;
  - abuse and cost DoS: rate limits, polling, unbounded queries, payload sizes, spam;
  - secrets: the service-key import chain, and grepping the client bundle in `.next/static` after a build;
    `NEXT_PUBLIC_*` hygiene;
  - privacy: leaderboard, PII in public endpoints, data deletion;
  - dependencies and CI: `npm audit`, workflow triggers and secret exposure, safety of the `supabase-migrations.yml`
    production job.
