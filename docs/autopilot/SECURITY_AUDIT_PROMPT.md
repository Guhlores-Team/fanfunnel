# Goal prompt — full security audit (run on Fable 5.1)

Run this **after the Command Center redesign has merged** (backlog item `SEC-AUDIT`), so the
audit covers the UI that's actually live. Paste everything below the line into a fresh
Claude Code session on this repo (model: `claude-fable-5-1`, e.g. `/model claude-fable-5-1`).
It is read-only against code and data: the output is a findings report plus backlog
entries, not fixes.

---

You are doing a complete, adversarial security audit of **FanFunnel**
(`Guhlores-Team/fanfunnel`): a Next.js 16 App Router app on Vercel with Supabase
(Postgres + Auth + RLS) at <https://fanfunnel.vercel.app>. The question to answer:
**what could anyone who encounters this site do that they shouldn't be able to?**

## Read first
`AGENTS.md` (auth contract — binding), `SECURITY.md`, `docs/SUPABASE_AUTH_CONTRACT.md`,
`docs/DEPLOY.md`, `docs/RELEASE_CHECKLIST.md` ([SEC] items), and the prior audits in
`docs/archive/multi-review-2026-06-17/`. Treat every earlier "fixed" or "safe" claim as
unverified until you have checked it in the current code.

## Attacker models (cover each one)
1. **Anonymous visitor**: no account, can hit every public page and `/api/*` route.
2. **Fan** holding one valid `/spin/[token]` link.
3. **Authenticated creator** (self-signed-up, possibly not yet approved).
4. **Agency/org member** acting for assigned creators.
5. **Malicious creator** targeting other tenants, fans, or the platform.
6. **Supply chain / CI**: dependencies, GitHub Actions, Vercel env scoping.

## Surface to cover (exhaustively)
- **AuthZ on every route handler** (~77 under `src/app/api/`): IDOR, missing owner checks,
  `can_act_for()` / `is_admin()` usage, suspended/unapproved/`is_active=false` accounts,
  mass assignment (role, features, creator_id in request bodies).
- **RLS + SQL** (`supabase/schema.sql`, `migrations/`): every policy, every SECURITY
  DEFINER function (search_path, grants/revokes to `anon`/`authenticated`, what each RPC
  lets a caller do when called directly with the anon key from a browser console).
- **Auth flows**: sign-up, login, approval gate (`/pending`), password reset,
  `/auth/callback` `next` redirect (open redirect), session cookies, `src/proxy.ts`.
- **Spin integrity & money paths**: double-spend races, `claim_spin`, grants/edits,
  referrals, happy-hour multipliers, provably-fair seed/nonce reuse, stock bypass.
- **Fan token secrecy**: leakage via Referer, logs, share cards, OG images, debug console,
  analytics, error messages; token entropy and enumeration.
- **Injection & XSS**: prize labels, chat messages, taglines, display names, avatars
  (upload type sniffing, SVG), webhook payloads, OG image rendering, `dangerouslySetInnerHTML`.
- **SSRF**: webhooks and any server-side fetch of user-supplied URLs (private IPs, DNS
  rebinding, redirects, cloud metadata endpoints).
- **CSRF / clickjacking / headers**: state-changing routes, CSP, framing, CORS.
- **Abuse & cost DoS**: rate limits (in-memory vs Upstash), polling amplification,
  unbounded queries, large payloads, spam via chat/sign-up/reports.
- **Secrets**: service-role key reachability (no `"use client"` import chain to
  `supabase/server`), client bundle (`npm run build`, then grep `.next/static` for key
  patterns), `NEXT_PUBLIC_*` hygiene, logs.
- **Privacy**: leaderboard exposure of fan spend, PII in public endpoints, data deletion.
- **Dependencies & CI**: `npm audit`, workflow triggers and secret exposure,
  `supabase-migrations.yml` prod job safety.

## Rules of engagement (hard)
- **Never send exploit or load traffic to production** (`fanfunnel.vercel.app`) or the prod
  Supabase project. Dynamic testing only against a local build (`npm run build && npm start`,
  mock mode) or, if credentials are present, the **test** Supabase project.
- Do not modify application code, migrations, or data. Do not change GitHub, Vercel, or
  Supabase settings. Do not merge anything.
- PoCs must be minimal and safe: a request sequence or a small script, never anything destructive.

## Deliverables
1. `docs/security/AUDIT-2026-10.md` containing:
   - Executive summary: counts by severity and the top 3 risks in plain language.
   - Findings table, then one section per finding: **ID** (`SEC-01`…), **severity**
     (Critical/High/Medium/Low/Info), attacker model, **concrete exploit scenario**,
     evidence (`file:line`), safe PoC, recommended fix, effort (S/M/L).
   - **Verified-safe list**: what you checked that held up, with evidence, so the next
     audit doesn't redo it.
   - The AGENTS.md four-question acceptance check, answered with `file:line` evidence.
2. Add each finding to `docs/autopilot/BACKLOG.md` at the `SEC-xx findings` marker (Critical
   and High first), as `- [ ] **SEC-xx** <title> (severity) …` in the backlog's format. Merge
   any overlapping `HARD-n` item into the finding and note that you did.
3. Commit both files on your branch, push, and open a PR titled
   `[security] Full audit — 2026-10` (docs only). Do not merge.
4. If you find something **Critical and exploitable today**, say so at the very top of the
   PR description and in your final message, so the owner sees it first.

Done means: every route handler and every RPC is accounted for (finding or verified-safe),
and every attacker model has been considered.
