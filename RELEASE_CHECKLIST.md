# FanFunnel — Pre-Release Mega Checklist

Compounded from a 4-angle review (security · correctness/data-layer · performance/resilience · UX/release-readiness). Each item has an **area**, **severity**, **file:line**, and the **action** to take. Work top-down.

---

## ✅ Already fixed & verified (no action — context only)
- **Spin count showed inflated aggregate (18 instead of 3)** — fixed; per-pass is now authoritative. Verified correct & complete, no sibling read bugs. (`index.ts:340-360, 481-483`)
- **Middleware 504 / `MIDDLEWARE_INVOCATION_TIMEOUT`** — fixed; short-circuits non-auth routes + 3s `getUser` timeout. Verified sound; the dropped routes (`/admin`, `/agency`, `/api/*`, `/spin`) are still protected at the page + data layer, so no auth bypass.
- **Spin latency** — 3 sequential DB reads → one `Promise.all`. Verified no correctness regression.
- **Security baseline is strong** — no Blocker/High/Medium issues. RLS, `SECURITY DEFINER` search_path pinning, `claim_spin` guards, admin bootstrap lock, route authz (no IDOR), webhook SSRF guard, secrets handling, server-side age-gate all verified correct.

> **Reminder:** none of the above is live until you **redeploy Vercel** from `main` and **restart the Unhealthy prod DB**.

---

## 🔴 TIER 1 — BLOCKERS (fix before release)

- [ ] **[PERF] The 116k req/hr flood: fan chat polls every 3s AND writes on every read.**
  `src/components/fan/ChatPanel.tsx:150` polls `GET /api/messages/fan` every 3s while open; `getFanMessages` does an `UPDATE messages SET read_at` on **every** GET (`src/lib/data/index.ts:5095`). ~97 open chat tabs = 116k/hr exactly. Also the closed-panel unread check (`ChatPanel.tsx:162`, 12s) runs on every tab.
  **Action:** poll open chat at **10s** (or use Supabase Realtime like the creator inbox); drop closed-panel check to 30–60s; **gate both behind `document.visibilityState`** so background tabs stop; make the read **idempotent** (only `UPDATE read_at` when there are actually unread creator messages); add a rate limit to the GET.

- [ ] **[UX-fan] No branded 404 / error page — dead/expired links drop the fan on Next.js's bare white "404".**
  No `not-found.tsx` / `error.tsx` / `global-error.tsx` exists; `spin/[token]`, `c/[slug]`, `share/[shareId]` all `notFound()`.
  **Action:** add `src/app/not-found.tsx` + `src/app/global-error.tsx` styled like the existing branded empty-state in `verify/[shareId]/page.tsx:27-50` — friendly "this link isn't active, ask your creator for a new one." ~30 min, highest-visibility fan moment.

---

## 🟠 TIER 2 — HIGH

### Performance (the rest of the flood + amplifiers)
- [ ] **[PERF] RecentWinsTicker polls every 20s, un-cached public endpoint, 3 round-trips.** `src/components/fan/RecentWinsTicker.tsx:41` → `/api/recent-wins/[creatorId]`.
  **Action:** it's social proof — staleness is fine. Poll 60s, cache server-side ~30–60s (`Cache-Control: s-maxage=30, stale-while-revalidate` or `unstable_cache`), visibility-gate, add IP rate limit.
- [ ] **[PERF] Dashboard polls never pause on hidden tabs (abandoned-tab amplifier).** `DashboardClient.tsx:90` (overview, 12s, 8 round-trips/call) and `:118` (metrics, 12s, 6 round-trips); the `visibilitychange` handlers only *add* a refresh, never `clearInterval`. Open inbox thread (`InboxPanel.tsx:337`, 6s) double-fetches and write-on-reads (`index.ts:5170`).
  **Action:** true `clearInterval` when `document.hidden`, restart on focus; slow overview to 20–30s; cache overview/metrics ~10-15s server-side; kill the inbox `onChanged → loadThreads` double-fetch.
- [ ] **[PERF] N+1 in campaign stats.** `getCampaignStats` (`index.ts:1117,1153`) runs 2–3 queries **per campaign** (40 campaigns = ~120 queries/request).
  **Action:** one batched `.in("campaign_id", ids)` query aggregated in JS (or a `group by` SQL); cache 30–60s.

### UX / compliance
- [ ] **[UX-fan] `?debug=1` console is live in production, sticky, can leak the fan's secret token, and ships a "force crash" button.** `src/components/debug/debug.ts:30-59`, mounted at `layout.tsx:42-49`. Off by default & XSS-safe, but no env gate; `localStorage` makes it permanent; captured stack traces can embed `/spin/<token>`.
  **Action:** gate `resolveDebug()` behind `process.env.NODE_ENV !== "production"` (or admin flag); drop/expire the `localStorage` persistence; redact `/spin/<token>` + query strings from captured text; hide the crash button in prod.
- [ ] **[UX-fan/compliance] Age-gate forces agreeing to a Terms of Service that has no page and isn't a link.** `SpinClient.tsx:477-481`; no `/terms` or `/privacy` route; landing has no legal footer.
  **Action:** add minimal `/terms` + `/privacy` pages, link them from the age-gate checkbox and a landing footer. (Adult-content product — real compliance exposure.)
- [ ] **[UX-creator] Webhook & happy-hour deletion have no confirmation (silent data loss).** `BoostsPanel.tsx:728-733` (webhook) and `:565-570` (happy-hour) — single-click DELETE, swallowed errors.
  **Action:** apply the two-step inline Confirm/Cancel pattern already used for wheels/fans/campaigns.
- [ ] **[UX-creator] Editing a historical grant changes a fan's live balance/revenue with no confirm or impact preview.** `FanDetailDrawer.tsx:539-559`.
  **Action:** show the resulting balance delta inline before saving; confirm when reducing spins.

---

## 🟡 TIER 3 — MEDIUM

### Correctness / data-layer
- [ ] **[CORRECTNESS] Referral bonus credits the fan aggregate only, never a pass — strands the spins & breaks the `fans == SUM(passes)` invariant.** `index.ts:992-1018`, `mock.ts:1091-1094`. **Dormant today** (no referral entry point wired), becomes **High** the moment referrals ship.
  **Action:** credit the bonus onto a specific pass (mirror `grantSpins` at `index.ts:1337-1353`), recompute the aggregate in lockstep; same in mock. **Gate referral launch on this fix.**
- [ ] **[CORRECTNESS] `editGrant` can desync aggregate vs sum-of-passes on partially-spent grants** (independent `Math.max(0,…)` clamps drift). `index.ts:1262-1301`.
  **Action:** after updating the pass, recompute `fans.spins_remaining = SUM(fan_passes.spins_remaining)` instead of applying the raw delta separately.
- [ ] **[CORRECTNESS] Concurrent double-spin reuses the same pre-committed server seed for two spins** (one commitment → two logged spins; outcomes differ only thanks to the nonce). `index.ts:562-635`.
  **Action:** make claim + seed-rotation atomic — ideally have `claim_spin` read-and-rotate `next_server_seed` in the same statement; or guard the rotation UPDATE on `.eq("next_server_seed", serverSeed)` and retry on 0 rows.
- [ ] **[CORRECTNESS] Verify page claims "committed before it was revealed" for fallback/legacy spins where the seed was generated at spin time.** `index.ts:614-619` + `verify/[shareId]/page.tsx:98-104`.
  **Action:** record on the spin row whether the seed was genuinely pre-committed; only show the timing verdict when true, else "seed integrity verified (not pre-committed)."

### Performance / security headers
- [ ] **[PERF] `/c/[slug]` profile and shared wheel-config reads are needlessly fully dynamic.** `c/[slug]/page.tsx:8` (`force-dynamic`); `getFanPass` re-reads the creator-shared wheel every load.
  **Action:** ISR the `/c/[slug]` marketing page (`revalidate = 60`); wrap the shared wheel-config read in `unstable_cache` keyed by wheelId, revalidate on edit. (The `/spin/[token]` page must stay dynamic — it's per-fan with writes.)
- [ ] **[PERF/SEC] Rate limiter is in-process per-instance** (`rateLimit.ts`) — resets on cold start, multiplies by instance count, and most public GETs have no limit.
  **Action:** move to a shared store (Upstash/Vercel KV) or lean on edge caching; at minimum add per-IP limits to `/api/recent-wins`, `/api/leaderboard`, `/api/messages/fan` (GET).
- [ ] **[SEC] No security response headers** (`next.config.ts` has no `headers()`). Spin-token can leak via `Referer`; no CSP backstop.
  **Action:** add `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a baseline CSP.

### UX
- [ ] **[UX-fan] Spin error handling misses `needs_ack` and `no_prizes` → generic "Something went wrong" dead-end.** `SpinClient.tsx:126-138`.
  **Action:** `needs_ack` → re-open the age gate; `no_prizes` → "This wheel has no prizes available right now — check back soon." (Also: `AgeGate` currently dismisses even if the ack POST fails — handle that.)
- [ ] **[UX-fan] "Pause my link" (self-exclude) tells the fan to refresh manually; SPIN stays live until they do.** `SafetyMenu.tsx:41`. (Server-side enforcement is correct — client-state gap only.)
  **Action:** `router.refresh()` / disable spinning immediately on success.
- [ ] **[UX-creator] Brand-color hex field is unvalidated and applied to the whole dashboard's `--brand`.** `DashboardClient.tsx:2145-2149`.
  **Action:** validate/normalize via the existing `safeColor()` from `Wheel.tsx` before binding `--brand`.
- [ ] **[UX-creator] Validation polish:** silent min-2-prize guard (`DashboardClient.tsx:2070`), toast-only form validation (no field highlight / `aria-invalid`), numeric inputs snap on clear (`DashboardClient.tsx:1104,1620`; `BoostsPanel.tsx:522`), "balance odds" writes fractional tickets (`editorHelpers.ts:117-147`).
  **Action:** disable the ✕ at 2 prizes with a tooltip; add inline `role="alert"`/`aria-invalid`; keep numeric inputs as string state, coerce on submit; round tickets to integers.

---

## 🟢 TIER 4 — LOW / NICE-TO-HAVE

- [ ] **[SEC] Supabase session cookie is `httpOnly:false`** (standard SSR tradeoff). If you don't need the browser client to read the session, pass `cookieOptions: { httpOnly: true }`; otherwise accept as known.
- [ ] **[SEC] Leaderboard auto-opts fans in on every spin (`index.ts:674`) and exposes per-fan spend (`index.ts:4841`).** Make opt-in an explicit fan action; consider dropping `spentCents` from the public board.
- [ ] **[SEC] Avatar upload trusts client `content-type`** (`api/account/avatar/route.ts:33`). Sniff magic bytes or set a fixed safe type from the validated extension. (Contained by per-user namespacing.)
- [ ] **[CORRECTNESS] mock vs real `nonce` basis differs** (`index.ts:615` per-pass-post-decrement vs `mock.ts:964` aggregate-pre). Use one canonical monotonic nonce in both, e.g. `spins_granted_total - spins_remaining`.
- [ ] **[CORRECTNESS] mock floors fractional happy-hour multiplier** (`mock.ts:2088` `Math.floor`); real accepts 2.5. Drop the floor in mock.
- [ ] **[CORRECTNESS] `fan_passes.spins_remaining` lacks the `>= 0` CHECK** that `fans.spins_remaining` has (`schema.sql:1705`). Add `check (spins_remaining >= 0)` (and for `spins_granted_total`).
- [ ] **[PERF] Tighten middleware matcher** (`src/middleware.ts:9`) to only `/dashboard/:path*`, `/login`, `/signup` so it doesn't even invoke on fan/API traffic. (Invocation cost, not DB.)
- [ ] **[PERF] Add exponential backoff to all poll loops** so a degraded/paused DB makes outages self-limiting instead of sustaining them.
- [ ] **[UX-fan] Chat sends on every Enter, no Shift+Enter newline** (`ChatPanel.tsx:263`). Newline on Shift+Enter.

---

## Free-tier survival (do in this order)
1. **Cache the read-heavy GETs** (`/api/recent-wins`, `/api/leaderboard`, `/api/overview`, `/api/metrics`) + ISR `/c/[slug]` — highest leverage; Vercel's edge absorbs most polling. Likely keeps you on free tier alone.
2. **Slow + visibility-gate every poll** (Tier 1/2) — cuts baseline ~3–5× and kills the abandoned-tab floor. Add backoff.
3. **Stop the write-on-read** in chat/inbox — writes are the most expensive op on a nano instance.
4. **Keep-alive** only fixes cold starts, not load — don't use it as a substitute. After 1–3, let it auto-pause (middleware tolerates a paused DB now).
5. **Pro tier** only as growth headroom after 1–3 — don't buy a bigger instance to melt instead of fixing polling.
