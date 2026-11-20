# FanFunnel — Pre-Release Mega Checklist

Compounded from a 4-angle review (security · correctness/data-layer · performance/resilience · UX/release-readiness). Each item has an **area**, **severity**, **file:line**, and the **action** to take.

**Status re-checked against the code on 2026-10-27 (branch `ops/golive-hardening`).** A ticked box cites the code or test that closes it. A box left open says what is still missing. Line numbers in the original findings referred to the old single-file `src/lib/data/index.ts`, which has since been split by domain (`src/lib/data/*.ts`).

The ordered go-live runbook (prod migrations, env vars, Supabase auth URLs and email templates, Vercel protection, smoke test, rollback) is in [`docs/GO_LIVE.md`](docs/GO_LIVE.md).

---

## ✅ Already fixed & verified before this list (context only)
- **Spin count showed inflated aggregate (18 instead of 3)**: fixed. The per-pass balance is authoritative (`src/lib/data/spins.ts` `getFanPass`, "Per-wheel" comment).
- **Middleware 504 / `MIDDLEWARE_INVOCATION_TIMEOUT`**: fixed. The proxy only runs on session routes (`src/proxy.ts` `matcher`).
- **Spin latency**: the fan-page reads run in one `Promise.all` (`src/lib/data/spins.ts` `getFanPass`).
- **Security baseline**: RLS on every table, definer `search_path` pinning, `claim_spin` guards, admin bootstrap lock, route authz, webhook SSRF guard. Guarded by `src/lib/security/*.test.ts` and `scripts/db/schema-drift-check.mjs`.

---

## 🔴 TIER 1 — BLOCKERS

- [x] **[PERF] Fan chat poll flood (3s poll + write on every read).** The open chat polls every 10s and the closed-panel unread check every 30s, both paused on hidden tabs with error backoff (`src/components/fan/ChatPanel.tsx` `startPoll({ intervalMs: 10000 …})` and `intervalMs: 30000`; scheduler `src/lib/poll.ts`). The read is idempotent: it only writes `read_at` when unread creator messages exist (`src/lib/data/inbox.ts` "rows we just fetched carry read_at"). The GET is rate-limited per IP (`src/app/api/messages/fan/route.ts` `msgread:`).
- [x] **[UX-fan] No branded 404 / error page.** `src/app/not-found.tsx` and `src/app/global-error.tsx` exist.

---

## 🟠 TIER 2 — HIGH

### Performance
- [x] **[PERF] RecentWinsTicker polling.** Done differently from the suggestion: it polls every 20s, paused on hidden tabs (`src/components/fan/RecentWinsTicker.tsx` `pollMs: 20000`), the route has an edge cache (`s-maxage=10, stale-while-revalidate=10`) and a per-IP limit (`src/app/api/recent-wins/[creatorId]/route.ts`).
- [x] **[PERF] Dashboard polls never paused on hidden tabs.** Every dashboard poll goes through `useFetch`/`startPoll`, which stops while the tab is hidden and backs off on errors (`src/lib/poll.ts`; commit 7940e4f "Pause polls on hidden tabs and back off on errors"). Overview/metrics still poll at 12s with no server-side cache: an optional follow-up, not a blocker.
- [x] **[PERF] N+1 in campaign stats.** One batched `.in("campaign_id", ids)` read per table (`src/lib/data/campaignStats.ts`; test `campaignStats.test.ts`). No extra cache layer.

### UX / compliance
- [x] **[UX-fan] `?debug=1` console live in production.** Mounted only when `NEXT_PUBLIC_ENABLE_DEBUG === "1"` (`src/app/layout.tsx`), which is set on Preview only. Legacy `localStorage` flag is cleared, and tokens and query strings are redacted (commit a184514).
- [~] **[UX-fan/compliance] Terms of Service with no page.** `/terms` and `/privacy` exist and are linked from the age gate (`src/components/SpinClient.tsx`) and the landing footer (`src/app/page.tsx`). **Still open (OWNER):** both are labelled placeholders (`src/components/LegalPage.tsx`) until reviewed legal text is supplied.
- [x] **[UX-creator] Webhook & happy-hour deletion without confirmation.** Two-step `RemoveConfirm` (`src/components/dashboard/BoostsPanel.tsx`).
- [x] **[UX-creator] Editing a historical grant with no impact preview.** The fan drawer previews the exact per-pass effect before saving (`src/components/dashboard/FanDetailDrawer.tsx`; test `src/lib/data/grantEditPreview.test.ts`).

---

## 🟡 TIER 3 — MEDIUM

### Correctness / data-layer
- [x] **[CORRECTNESS] Referral bonus credited only the aggregate.** The bonus now lands on a pass (commit 16613ee; test `src/lib/data/referralIntegrity.test.ts`).
- [x] **[CORRECTNESS] `editGrant` could desync aggregate vs passes.** It adjusts the pass with a compare-and-swap and the aggregate stays `SUM(passes)` via the 0035 trigger (`src/lib/data/fans.ts`; test `src/lib/data/editGrantLedger.test.ts`).
- [x] **[CORRECTNESS] Concurrent double-spin reused one committed seed.** The seed is consumed with a compare-and-swap (commit 04d95e7; test `src/lib/data/spinSeedRace.test.ts`).
- [x] **[CORRECTNESS] Verify page over-claimed pre-commitment.** It now states whether the seed was really pre-committed (commits fea3811, d806f65; test `src/lib/data/spinCommitment.test.ts`).

### Performance / security headers
- [~] **[PERF] `/c/[slug]` and shared wheel-config reads fully dynamic.** `/c/[slug]` is ISR (`src/app/c/[slug]/page.tsx` `revalidate = 60`). **The wheel-config read is deliberately NOT cached.** A cache would need an invalidation on every write path, and some writes cannot trigger one: the stock compare-and-swap on every limited-prize win (`src/lib/data/spins.ts` `takeStockUnit`), the database-side stock refund (`rollback_claimed_spin`, 0038), and direct PostgREST writes that RLS allows the creator's own session to make. A stale prize list on the fan page would show prizes or stock that the live draw no longer has. The page is per-fan and writes on load anyway (seed commitment), so the saving would be one query. See the go-live hardening report.
- [x] **[PERF/SEC] Rate limiter in-process per instance.** Shared through Upstash Redis when `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) are set, else falls back to memory (`src/lib/rateLimit.ts` `upstashEnv`). Recent-wins, leaderboard and fan-message GETs have per-IP limits.
- [x] **[SEC] No security response headers.** `Referrer-Policy`, `X-Content-Type-Options: nosniff` and a CSP are set in `next.config.ts` `securityHeaders`.

### UX
- [x] **[UX-fan] Spin errors `needs_ack` / `no_prizes`.** Mapped to specific messages (`src/components/spinErrors.ts`). The age gate stays open if the acknowledgement fails to save (commit 38c2a75).
- [x] **[UX-fan] "Pause my link" left SPIN live.** SPIN disables at once through `LinkPauseProvider` (`src/components/fan/SafetyMenu.tsx` `markPaused()`).
- [x] **[UX-creator] Brand colour unvalidated.** Normalised with `normalizeHex`, and an invalid value blocks save with an accessible error (`src/components/dashboard/WheelEditor.tsx`; commit c52a9b3).
- [x] **[UX-creator] Validation polish.** Inline accessible errors (commit 7d72b09), whole-number tickets (e44c344), a 0-ticket "can't be won" note (2ca5b3d).

---

## 🟢 TIER 4 — LOW / NICE-TO-HAVE

- [x] **[SEC] Session cookie `httpOnly:false`.** Accepted on purpose: the browser client must read the session. `Secure` is added on https (commit 903e9ba; test `src/lib/supabase/cookies.test.ts`).
- [x] **[SEC] Leaderboard auto opt-in and public spend.** Opt-in is an explicit fan action with a board name, and no spend is in the public payload (commits d10b7d4, 9450894; test `src/lib/data/leaderboardPrivacy.test.ts`).
- [x] **[SEC] Avatar upload trusted the client content-type.** The type comes from magic bytes (`src/app/api/account/avatar/route.ts` `sniffImageMime`).
- [x] **[CORRECTNESS] Mock vs real nonce basis differed.** Unified (commit 35b4337; test `src/lib/data/spinParity.test.ts`).
- [x] **[CORRECTNESS] Mock floored the happy-hour multiplier.** Fixed in the same commit 35b4337.
- [x] **[CORRECTNESS] `fan_passes` balance CHECKs.** `spins_remaining >= 0` since migration 0039. `spins_granted_total >= 0` (plus `fans.spins_granted_total`, `fans.rl_count`, `prizes.stock`, `prizes.cost_cents`) since migration 0052. Each is validated only when no row violates it; otherwise it is dropped with a WARNING and history is never rewritten (`supabase/migrations/0052_org_rls_and_ledger_checks.sql`; test `src/lib/security/orgRlsLedger0052.test.ts`).
- [x] **[PERF] Tighten the middleware matcher.** `src/proxy.ts` `matcher` covers only dashboard/admin/agency/auth routes (commit 952eafc).
- [x] **[PERF] Exponential backoff on poll loops.** `src/lib/poll.ts` (commit 7940e4f).
- [x] **[UX-fan] Chat sent on every Enter.** Shift+Enter inserts a newline (`src/components/fan/ChatPanel.tsx` `!e.shiftKey`).

---

## Free-tier survival (status)
1. Cache the read-heavy GETs: recent-wins has an edge cache and `/c/[slug]` is ISR. Overview/metrics are uncached (optional).
2. Slow down and visibility-gate every poll: done (`src/lib/poll.ts`).
3. Stop the write-on-read in chat and inbox: done (idempotent `read_at` update).
4. Keep-alive is not a substitute for 1–3.
5. Move to the Pro tier only as growth headroom.
