# FanFunnel — Big Bets Research & Implementation Plan

**Author:** Principal Product Strategist
**Date:** 2026-05-31
**Status:** Planning doc (no application code). Data-model sketches are grounded in the real schema — see `supabase/schema.sql`, the migrations under `supabase/migrations/` (through the latest), and `src/lib/data/index.ts`.

This document plans three "big bet" features:

1. **Agency console** — a real B2B multi-creator org layer on top of today's single-tenant `/admin`.
2. **"Autopilot" prescriptive action feed** — turn the existing analytics into a daily ranked "run your business" to-do list.
3. **Compliance-as-a-moat** — age assurance, leak-resistant delivery, processor safety as the *reason* serious creators/agencies choose FanFunnel. Deliberately framed as the **later** differentiator with explicit "when to start" triggers.

A short **sequencing recommendation** and **dependencies on Phase 7 hardening** close the doc.

---

## Grounding: what already exists (and what we reuse)

| Capability | Where it lives | Reuse for |
|---|---|---|
| Dual `admin`+`creator` role, `is_active`, `approval_status`, `features` jsonb | `profiles` (schema.sql:33), migration `0011` | Agency seats layer on top of `profiles` |
| Cross-account admin RPC + panel | `admin_account_stats()` (schema.sql:240), `getAdminOverview()` (index.ts:2835), `/admin` page | Seed of the **org roll-up dashboard** |
| RLS pattern: `creator_id = auth.uid() or is_admin()` | every owner table (schema.sql:298–334) | The thing we must **carefully extend** for org seats |
| `is_admin()` SECURITY DEFINER helper | schema.sql:188 | Template for `is_org_member()` / `can_act_for()` |
| Fans / LTV / dormancy | `fans`, `grants`, `getCreatorCrm()` (index.ts:1136), `listFans()` (index.ts:1045) | Autopilot whale + win-back cards |
| Best-time heatmap (7×24 UTC) | `getEngagementHeatmap()` (index.ts:2591) | Autopilot "hot slot" card |
| Prize ROI + rarity + `cost_cents` + `stock` | `getPrizeRoi()` (index.ts:2638), `prizes` (schema.sql:63, mig `0006`) | Autopilot over-given / low-stock cards |
| Cohort retention | `getCohortRetention()` (index.ts:2696) | Autopilot cohort-decay card |
| Conversion funnel + revenue trend | `getMetricsExtra()` (index.ts:2505) | Autopilot funnel-leak card |
| Fulfilment queue + `due_at` + `in_progress` | `redemptions` (mig `0007`), `getOverview()` (index.ts:2409) | Autopilot "fulfil overdue" card; agency VA seats |
| DM templates + Realtime inbox + auto intro/outro | `dm_templates`, `messages`, `ensureChatIntro/sendChatOutro` (index.ts:3966/4004) | Autopilot one-tap DM execution |
| Happy-hour scheduler | `happy_hours` (mig `0005`), `createHappyHour()` (index.ts:3100) | Autopilot "schedule a drop" execution |
| Provably-fair spins (commit/reveal) | `spins.server_seed*` (mig `0008`), `getSpinVerification()` (index.ts:3209) | Compliance: tamper-evidence story |
| Webhooks | `webhooks` (mig `0009`), `fireWebhooks()` (index.ts:3325) | Compliance moderation hooks; agency event fan-out |
| Block / report / self-exclude / rate-limit | `fans.blocked_at`, `creator_reports`, `fan_passes.self_excluded_at`, `claim_spin()` rate limit (mig `0012`) | Compliance: block/report partly built |
| Prize media storage (public bucket) | `prize-photos` bucket (schema.sql:561) | Compliance: must become **private + signed/watermarked** |
| Age-gate ack | `fans.acked_at` (mig `0009`) | Compliance: upgrade from "checkbox" to real age assurance |

**Architectural facts that constrain all three bets:**
- Next.js 16 app-router; **all data access flows through `src/lib/data/index.ts`** (server functions), surfaced via `/api/*` routes. New features should add functions there, not bypass it.
- Fans are **not** auth users; fan writes go through the **service role** server-side. RLS only governs creator/admin (authenticated) access.
- The dashboard is effectively one route (`/dashboard`) that tabs client-side; `/admin` is the cross-account panel. A new "Today" tab and an "Agency" surface fit this shape.
- There is a `mock.ts` parallel implementation; every new data function is expected to have a mock branch (`isSupabaseConfigured()` guard pattern).

---

# Big Bet 1 — Agency Console (B2B multi-creator)

## Problem & why it's a moat
Agencies ("management") run stables of 5–50 adult creators with teams of VAs (chatters, fulfilment ops, marketers). Today FanFunnel's `/admin` is single-tenant-ish: **one** admin sees **all** accounts via `is_admin()`. There is no concept of *an agency that owns some creators but not others*, and no concept of *a seat with limited powers* (a chatter who can DM and fulfil but must not touch payouts or delete a wheel).

The moat is **switching cost + workflow lock-in**: once an agency runs its roster, seat permissions, and consolidated revenue reporting through FanFunnel, ripping it out means rebuilding ops. B2B multi-seat also flips the unit economics from "$X/creator" to "$X/seat + rev-share across a roster," which is the only path to meaningful ACV in this space.

## Target user & JTBD
- **Agency owner / OBM:** "When I take on a new creator, I want to spin up their wheels and grant my team scoped access in minutes, so I can scale my roster without giving everyone the keys."
- **VA / chatter (seat):** "When I start my shift, I want to fulfil prizes and answer fan DMs for *my assigned* creators only, without being able to break anything I shouldn't touch."
- **Agency finance:** "When I close the month, I want one roll-up of revenue/fulfilment across all creators, with per-creator drill-down."

## Data model sketch (grounded in real schema)

The key design choice: **keep `profiles.id` as the creator identity** (everything is already keyed to `creator_id = profiles.id`). Add an org layer *beside* it, plus a **membership table that maps a person to the creators they may act for, with a role**. Permission checks resolve to a SECURITY DEFINER predicate `can_act_for(target_creator_id)` that *replaces* the bare `creator_id = auth.uid()` in RLS.

```sql
-- New enum: a seat's role within an org.
create type org_role as enum ('owner','manager','chatter','fulfiller','analyst');

-- An organization (agency). The creator accounts it owns are linked below.
create table public.orgs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  owner_id      uuid not null references public.profiles(id),  -- billing contact
  billing_model text not null default 'per_seat',  -- 'per_seat' | 'rev_share'
  rev_share_bps integer,                            -- e.g. 1500 = 15% (if rev_share)
  created_at    timestamptz not null default now()
);

-- A creator account belongs to (at most) one org. A creator NOT in any org keeps
-- today's exact single-creator behaviour (org_id is null → old RLS path).
alter table public.profiles
  add column org_id uuid references public.orgs(id) on delete set null;

-- A person (staff) is a member of an org with a role. The person is a profile
-- with role='creator' but typically is_active for login only — they own no
-- wheels themselves. (We reuse profiles so auth/login is unchanged.)
create table public.org_members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  role        org_role not null default 'chatter',
  created_at  timestamptz not null default now(),
  unique (org_id, profile_id)
);

-- Scoping: which creators a NON-owner/manager seat may act for. Owners and
-- managers implicitly cover every creator in the org (no rows needed).
create table public.org_member_creators (
  id              uuid primary key default gen_random_uuid(),
  org_member_id   uuid not null references public.org_members(id) on delete cascade,
  creator_id      uuid not null references public.profiles(id) on delete cascade,
  unique (org_member_id, creator_id)
);
```

### Role → permission matrix (enforced in both RLS and UI)

| Capability | owner | manager | chatter | fulfiller | analyst |
|---|:--:|:--:|:--:|:--:|:--:|
| View roll-up dashboard / analytics | ✅ | ✅ | scoped | scoped | ✅ |
| Switch into a creator | all | all | assigned | assigned | all (read) |
| Read/send fan DMs (`messages`) | ✅ | ✅ | ✅ | — | — |
| Fulfil redemptions (`redemptions`) | ✅ | ✅ | — | ✅ | — |
| Grant spins (`grants` — money in) | ✅ | ✅ | — | — | — |
| Edit/delete wheels & prizes | ✅ | ✅ | — | — | — |
| Manage payouts / billing / rev-share | ✅ | — | — | — | — |
| Manage seats (`org_members`) | ✅ | ✅ (not owner) | — | — | — |

Encode the matrix as a small JSON map in code (single source of truth), and mirror the *coarse* gates in RLS. Suggested permission keys: `analytics:read`, `creator:switch`, `chat:write`, `redemption:write`, `grant:write`, `wheel:write`, `billing:manage`, `seat:manage`.

### How it layers on existing RLS without breaking single creators

Today's policy is, e.g.:
```sql
create policy wheels_rw on public.wheels for all
  using (creator_id = auth.uid() or public.is_admin()) ...
```
Introduce a single SECURITY DEFINER predicate and **add it as an OR branch** so existing single-creator behaviour is untouched (a creator with `org_id IS NULL` and no membership still passes via `creator_id = auth.uid()`):

```sql
create function public.can_act_for(p_creator uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- 1) the creator acting on their own rows (unchanged)
    (p_creator = auth.uid())
    -- 2) global platform admin (unchanged)
    or public.is_admin()
    -- 3) an org seat that (a) belongs to the same org as the target creator,
    --    (b) is scoped to that creator (or is owner/manager), and (c) whose
    --    role grants p_perm. Permission→role logic lives in a lookup table or
    --    is inlined here per perm.
    or exists (
      select 1
      from public.org_members m
      join public.profiles tc on tc.id = p_creator
      where m.profile_id = auth.uid()
        and m.org_id = tc.org_id
        and (
          m.role in ('owner','manager')
          or exists (select 1 from public.org_member_creators mc
                     where mc.org_member_id = m.id and mc.creator_id = p_creator)
        )
        and public.role_has_perm(m.role, p_perm)  -- matrix lookup
    );
$$;
```
Then RLS becomes, per table and per operation, e.g. for `redemptions` UPDATE: `using (public.can_act_for(creator_id, 'redemption:write'))`. **Crucially, split `for all` policies into per-command policies** (`select`/`insert`/`update`/`delete`) so a chatter can `select` a wheel but not `update`/`delete` it — the current `for all` lumps them together and cannot express that.

### Org dashboard
- New surface at `/agency` (or an "Agency" tab gated on `org_members.role in (owner,manager,analyst)`).
- Roll-up = generalize `admin_account_stats()` into `org_account_stats(p_org uuid)` that aggregates `wheels/fans/spins/pending` **and revenue** (sum `grants.amount_cents`) **scoped to the org's creators** instead of all profiles. Reuse the exact shape `getAdminOverview()` already maps (index.ts:2835).
- **Switch-into-creator**: a server action sets a `acting_as_creator_id` in an httpOnly cookie/session; the data layer reads it and, when present and `can_act_for` passes, scopes queries to that creator. This is the cleanest path because *every* existing `getX()` already filters `creator_id = user.id` — we change `user.id` to "the effective creator id." Add a helper `effectiveCreatorId(sb)` and thread it through the data layer.

### Billing model
- **Per-seat** (default, simplest): `orgs.billing_model='per_seat'`, count active `org_members`, bill monthly. Off-platform invoicing first (matches "payment happens off-platform" reality).
- **Rev-share** (premium / aligns incentives): `rev_share_bps` × org's `grants.amount_cents` for the period. We already capture money in `grants`, so the number exists — but note grants are *creator-recorded*, not processor-verified, so rev-share billing on them is an honor-system metric until on-platform payments exist (ties to Big Bet 3).

## Phased build

| Phase | Scope | Effort |
|---|---|---|
| **A — Read-only roll-up** | `orgs`, `org_members`, `profiles.org_id`; `org_account_stats()` RPC; `/agency` dashboard (revenue + fulfilment roll-up, per-creator drill). No seat writes yet; owner-only. Reuses `getAdminOverview` shape. | **M** |
| **B — Scoped seats + switch-into-creator** | `org_member_creators`, `org_role`, `role_has_perm`, `can_act_for`; **split `for all` RLS into per-command policies** across owner tables; `effectiveCreatorId()` + acting-as cookie; seat-management UI; permission gates in UI. | **L** |
| **C — Billing + lifecycle** | per-seat counting + rev-share calc, invoices/exports, audit log of seat actions (`org_audit_log`), invite flow (reuse `/api/admin/invite`), creator onboarding wizard (clone wheel templates). | **M** |

## Key risks & hardest parts
1. **RLS correctness is the whole ballgame.** Splitting `for all` into per-command policies across ~10 tables, each calling `can_act_for(creator_id, perm)`, is error-prone and must be tested with a policy test matrix (one authed seat per role × each table × each verb). A single missed `with check` lets a chatter escalate.
2. **`can_act_for` recursion / performance.** It joins `profiles` (which has RLS). Keep it SECURITY DEFINER (like `is_admin()`) to avoid recursion, and **index** `org_members(profile_id, org_id)` and `org_member_creators(org_member_id, creator_id)`. It runs on every row check — keep it cheap.
3. **The "acting-as" footgun.** Switch-into-creator changes the effective writer. Every write path must re-validate `can_act_for` server-side (never trust the cookie alone), and the **service-role** fan-write paths must be careful never to inherit an unscoped acting context.
4. **Don't break solo creators.** The `org_id IS NULL` path must remain byte-for-byte the old behaviour. Add a regression test that a non-org creator's RLS is unchanged.
5. **`is_admin()` vs org owner.** Platform admin (you) is *not* an org owner. Keep them distinct; admin retains god-mode for support, org owner is scoped to their org.

## Success metric
**Activated agencies** (orgs with ≥2 creators and ≥2 active non-owner seats that performed a scoped action in the last 7 days) and **roster-weighted retention** (revenue retained across an org vs. per-creator churn). Leading indicator: median time from "create org" to "first VA fulfils a prize."

---

# Big Bet 2 — "Autopilot" Prescriptive Action Feed

## Problem & why it's a moat
FanFunnel already computes whales, dormancy, hot slots, prize ROI, cohorts, funnels — but they live as **charts the solo creator must interpret and act on**. Solo adult creators are time-poor and not analysts; charts don't get acted on. The moat is **converting analytics into completed actions**: a daily ranked to-do list where each card is one tap to execute using tools we already have (DM templates, happy-hour scheduler, wheel editor, CRM copy-link). This is sticky because it becomes the creator's morning routine, and it compounds — the more they act, the better the ranking learns.

## Target user & JTBD
- **Solo creator:** "When I open FanFunnel in the morning, I want a short, honest list of the highest-impact things to do *right now*, each pre-drafted so I can do it in one tap, so I make more money without becoming a data analyst."
- Secondary: an **agency VA** (Bet 1) running this feed per assigned creator as a shift checklist.

## The 12 action-card types (trigger logic → recommended action → one-tap execution)

All triggers read from existing tables / data functions. "One-tap" reuses an existing flow.

| # | Card | Trigger (data source) | Recommended action | One-tap execution |
|---|---|---|---|---|
| 1 | **DM these N whales** | Top LTV fans from `getCreatorCrm().whales` (index.ts:1162) who haven't been DM'd in 7d (no creator `messages` row recently) | Send a thank-you / VIP offer | Open thread prefilled from a `dm_templates` body (`sendCreatorMessage`, index.ts:3887) |
| 2 | **Win back dormant spenders** | `getCreatorCrm().dormant` (LTV>0, `daysSince ≥ 14`, index.ts:1163) | "We miss you" + bonus-spin nudge | DM template + optionally `grantSpins` bonus (index.ts:1005) |
| 3 | **Schedule a drop in your hot slot** | Peak cell from `getEngagementHeatmap()` (index.ts:2591) when no `happy_hours` window overlaps it in next 7d | Schedule a happy-hour multiplier at peak weekday/hour | `createHappyHour()` prefilled with the slot (index.ts:3100) |
| 4 | **Raise rarity of an over-given prize** | Prize whose share of recent wins ≫ its intended rarity tier (compare `getPrizeRoi().timesWon` distribution vs `prize.rarity`/`weight`) | Lower its `weight` / bump rarity so it stays special | Deep-link wheel editor to that prize (`saveWheel`, index.ts:1591) |
| 5 | **Restock a low/zero-stock prize** | `prizes.stock` ≤ threshold or 0 (it stops appearing at 0) | Restock or replace the segment | Wheel editor → prize `stock` field |
| 6 | **Fulfil overdue prizes** | `redemptions` with `status='pending'` and `due_at < now()` (mig `0007`; `getOverview().redemptions`) | Fulfil now / mark in-progress | `setRedemptionStatus` (index.ts:2765) inline |
| 7 | **Answer waiting fans** | Unread fan `messages` (`getOverview().metrics.unreadMessages`, index.ts:2475) older than X hours | Reply to oldest first | Open inbox thread (`getThread`, index.ts:3858) |
| 8 | **High-intent fan is out of spins** | Fan with `spins_remaining = 0` who spun recently AND has spend (LTV>0) — from `listFans()` | Nudge to rebuy / send their buy link | Copy fan's `primaryToken` link + DM template |
| 9 | **A campaign is converting — pour fuel on it** | Campaign with high returning rate from `getCohortRetention()` (returningFans/fans, index.ts:2696) | Mint more links / pin its wheel | `setCampaignPinnedWheel` (index.ts:2180) + copy share link |
| 10 | **A campaign is leaking at "spun → fulfilled"** | `getMetricsExtra().funnel` (index.ts:2548) where `spun` ≫ `fulfilled` | Clear the fulfilment backlog | Jump to fulfilment queue |
| 11 | **Set up your money-loser prizes' costs** | Prizes with `cost_cents IS NULL` that are being won (so ROI is blind) | Add `cost_cents` so ROI works | Wheel editor prize cost field |
| 12 | **Capture a wishlist demand spike** | `getWishlistDemand()` (index.ts:3461) shows a prize wished-for by many fans but not on the live wheel | Add that prize / DM interested fans | Wheel editor add-prize, or DM the wishers |

(Plus latent extras for later: referral-laggard nudge from `getReferralStats()` index.ts:3679; leaderboard-off-but-eligible suggestion; "new fan, never spun" onboarding nudge.)

## Action-generation engine
- **Rules first, ML later.** Each card type is a pure function `generate(ctx) → ActionCard[]` over already-fetched analytics. Add a new data-layer function `getAutopilotFeed()` in `index.ts` that calls the existing getters (`getCreatorCrm`, `getEngagementHeatmap`, `getPrizeRoi`, `getMetricsExtra`, `getOverview`, `getWishlistDemand`, `listFans`) **once**, runs all generators, filters out dismissed/snoozed, ranks, and returns the top N (≈5–7).
- Run it server-side on dashboard load; it's read-mostly and cheap because it piggybacks on getters that already exist. Optionally precompute nightly into `autopilot_cards` for speed + so "done/snoozed" state is durable.
- **ML later** = same `ActionCard` contract, but `score` comes from a model trained on which cards got executed and what revenue followed. The rules version produces the labels.

## Ranking model
`priority = impact × urgency × (1 / effort)` where:
- **impact** (1–5): expected revenue effect — whale DM and restock-of-popular-prize score high; "add a cost field" scores low.
- **urgency** (1–5): time-decay — overdue fulfilment and waiting DMs spike; "raise rarity" is low.
- **effort** (1–3): taps to complete — one-tap = 1.
Tie-break by recency of trigger. Cap one card per type per day to avoid a feed full of "DM a whale."

## Data model (dismiss / snooze / done)

```sql
create type autopilot_status as enum ('open','snoozed','done','dismissed');

create table public.autopilot_cards (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  card_type     text not null,            -- e.g. 'dm_whales', 'hot_slot_drop'
  dedupe_key    text not null,            -- type + subject id (fan/prize/campaign) + day-bucket
  subject_ref   jsonb not null default '{}'::jsonb,  -- {fanId, prizeId, slot, ...}
  impact        smallint not null,
  urgency       smallint not null,
  effort        smallint not null,
  score         numeric  not null,
  status        autopilot_status not null default 'open',
  snooze_until  timestamptz,
  acted_at      timestamptz,             -- for learning: did they execute it?
  created_at    timestamptz not null default now(),
  unique (creator_id, dedupe_key)        -- never re-nag the same thing same day
);
create index autopilot_open_idx on public.autopilot_cards(creator_id, status, score desc);
alter table public.autopilot_cards enable row level security;
create policy autopilot_rw on public.autopilot_cards for all
  using (creator_id = auth.uid() or public.is_admin())
  with check (creator_id = auth.uid() or public.is_admin());
```
`dedupe_key` is the honesty/anti-nag guard: the same whale, prize, or slot won't reappear after dismiss until the underlying signal *materially* changes (e.g. LTV crosses a new band, stock drops to 0). Snooze sets `snooze_until`; the generator skips snoozed cards until then.

## Where it lives in the UI
- A new **"Today"** tab as the dashboard's default landing view (the `/dashboard` route already tabs client-side). A stacked list of ≤7 cards, each with a primary action button + Snooze/Dismiss. A small "why am I seeing this?" line citing the real number (e.g. "Last active 21 days ago, spent $140").
- A header chip "3 things to do today" wherever the creator is.

## How to keep it honest (never fabricate urgency)
- **Every card cites its real datum** (the exact count/date/dollar from the source getter). No card without a concrete trigger value.
- **No fake scarcity/streaks.** Urgency only spikes on genuinely time-bound facts: `due_at` passed, message aging, stock=0, a scheduled hot slot approaching.
- **Suppression rules:** if there's nothing worth doing, show an honest empty state ("You're caught up") — never pad the feed.
- **Dedupe + cooldown** so the same suggestion can't be re-shown as "urgent" daily.
- This matters extra in adult-creator/monetization context: the feed must read as a *competent ops assistant*, not a dark-pattern dopamine machine.

## Phased build

| Phase | Scope | Effort |
|---|---|---|
| **A — Read-only feed** | `getAutopilotFeed()` computing 5 highest-value card types (1,2,3,6,7) from existing getters; "Today" tab rendering; deep-links to existing flows. No persistence (compute live). | **M** |
| **B — State + ranking + remaining cards** | `autopilot_cards` table, dismiss/snooze/done, `dedupe_key` cooldowns, full impact×urgency×effort ranking, cards 4,5,8–12. | **M** |
| **C — Learning loop + scheduling** | log `acted_at`/outcome, nightly precompute, optional email/push "your 3 things today," A/B the ranking weights; groundwork for ML scoring. | **L** |

## Key risks & hardest parts
1. **False positives erode trust fast.** Card 4 ("over-given prize") is the trickiest: distinguishing "intentionally common" from "miscalibrated" needs comparing observed win-share to the *intended* distribution implied by `weight`+`rarity`, not a naive threshold. Ship it conservative.
2. **Cheap, correct aggregation.** Several getters re-scan `spins`/`grants`; calling them all on every dashboard load is fine at one-creator scale but needs the nightly precompute (Phase C) before roster scale (Bet 1).
3. **One-tap must truly be one tap.** If "schedule a drop" dumps the user in a raw `happy_hours` form, the value collapses. Each execution must be **prefilled** from the card's `subject_ref`.
4. **Dedupe semantics.** Getting `dedupe_key` right (so it re-surfaces only on material change) is subtle and is the difference between "helpful" and "nagging."

## Success metric
**Action completion rate** (cards executed ÷ cards shown) and **revenue attributable to executed cards** (grants/messages within 72h of a card action). Guardrail: dismiss-without-acting rate < 50% per card type (else that card type is noise and gets cut).

---

# Big Bet 3 — Compliance-as-a-Moat

> **Framing / "when to start":** The user is deliberately deferring most compliance while testing with **one** creator. This is correct — most items below are not legally required to run a single-creator pilot where money moves off-platform. Treat compliance as the **later differentiator**. Concrete start triggers:
> - **Trigger 1 (onboard creator #2 / first agency):** stand up real **age assurance** for fans on regulated traffic, private/signed prize media, and block/report polish. You now process *other people's* audiences and content.
> - **Trigger 2 (take payments on-platform / handle disputes):** stand up **chargeback evidence packs**, processor-grade KYC, and the **2257-style records vault**. Money + content custody = real legal exposure.
> - **Trigger 3 (UK/EU/US-state age-verification laws bite for your traffic):** per-jurisdiction age-gating becomes table-stakes.

## Problem & why it's a moat
The category's existential fears are **de-platforming, leaks, and legal liability** (2257 record-keeping, minors, chargebacks, payment-processor bans). Today FanFunnel has only a *checkbox* age-gate (`fans.acked_at`, mig `0009`) and a **public** prize-media bucket (`prize-photos`, world-readable — schema.sql:561). If we instead make verified-age + leak-resistant delivery + processor-safety **the reason serious creators/agencies pick FanFunnel**, compliance flips from cost center to the premium selling point and the enterprise wedge for agencies (who carry the legal risk for their roster).

## Target user & JTBD
- **Serious creator / agency:** "When I put my content and my fans on a platform, I want provable age verification, leak-resistant delivery, and dispute evidence, so I don't get de-platformed, sued, or chargeback-bombed."
- **Agency owner (Bet 1):** "When I onboard a creator, I want one audit trail (2257-style) for the whole roster, so a processor or auditor request is a click, not a panic."

## Data model sketch (grounded in real schema)

```sql
-- Real age assurance (replaces the bare fans.acked_at checkbox).
create type age_check_status   as enum ('unverified','pending','verified','failed','expired');
create type age_check_provider as enum ('yoti','veriff','stripe_identity','manual');

create table public.age_verifications (
  id            uuid primary key default gen_random_uuid(),
  fan_id        uuid references public.fans(id) on delete set null,  -- fans aren't auth users
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  provider      age_check_provider not null,
  status        age_check_status not null default 'pending',
  provider_ref  text,            -- provider's verification id (NOT raw PII)
  method        text,            -- 'document' | 'estimation' | 'reusable_credential'
  jurisdiction  text,            -- ISO country/region used for gating
  verified_at   timestamptz,
  expires_at    timestamptz,     -- re-verify cadence per jurisdiction
  created_at    timestamptz not null default now()
);
-- We store the provider's pass/fail + reference ONLY. Never store the ID image.

-- Per-creator/per-jurisdiction gating policy (which regions require hard verify).
create table public.compliance_policies (
  creator_id      uuid primary key references public.profiles(id) on delete cascade,
  require_age_verify boolean not null default false,
  gated_regions   text[] not null default '{}',   -- ISO codes needing hard verify
  retention_days  integer,                          -- data-retention window
  updated_at      timestamptz not null default now()
);

-- 2257-style record-keeping vault: who is depicted in each piece of prize media,
-- with the custodian and consent record. Append-only; admin/owner read.
create table public.content_records (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  prize_id      uuid references public.prizes(id) on delete set null,
  media_path    text not null,           -- private bucket object key
  performer_ref text,                     -- pointer to performer's verified-age record
  custodian     text,                     -- records custodian name/address
  recorded_at   timestamptz not null default now()
);

-- Watermark + signed-delivery audit: every issued URL is logged so a leak can be
-- traced to the recipient (forensic watermark = fan_id baked into the asset/URL).
create table public.media_access_log (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  fan_id      uuid references public.fans(id) on delete set null,
  media_path  text not null,
  signed_url_exp timestamptz not null,
  watermark   text,                       -- e.g. hash(fan_id+ts)
  issued_at   timestamptz not null default now()
);

-- Chargeback / dispute evidence pack: assembled from existing data + signed media.
create table public.dispute_packs (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references public.profiles(id) on delete cascade,
  fan_id      uuid references public.fans(id) on delete set null,
  grant_id    uuid references public.grants(id) on delete set null,
  evidence    jsonb not null default '{}'::jsonb,  -- spins, age-verify, fulfilment, IPs, acks
  created_at  timestamptz not null default now()
);
```
All tables get the standard `creator_id = auth.uid() or is_admin()` RLS (upgraded to `can_act_for(..., 'compliance:read')` once Bet 1 lands). The `content_records` and `age_verifications` tables are **append-only / no public read** and never store raw ID images — only provider references and pass/fail.

### The single most important change: private prize media
Today `prize-photos` is a **public** bucket (`storage.buckets ... public=true`, schema.sql:562) with world-readable select (schema.sql:567). For leak-resistant delivery this must become:
- a **private** bucket, delivered via **short-lived signed URLs** generated server-side per fan view (logged in `media_access_log`),
- with a **forensic watermark** (fan-specific overlay or steganographic tag) so a leaked asset traces to the fan,
- migrated carefully (existing `prizes.image_url` / `spins.prize_image_url` are public URLs and must be re-pointed to a signing endpoint).

### Age assurance provider options
| Provider | Strength | Fit |
|---|---|---|
| **Yoti** | Age *estimation* (no ID needed) + reusable digital ID; built for adult sector | Best low-friction default for fans; jurisdiction-aware |
| **Veriff** | Document + liveness, broad coverage | Hard-verify for strict jurisdictions |
| **Stripe Identity** | Tight if/when payments move on-platform | Pairs with on-platform payments + KYC |

Gate per `compliance_policies.gated_regions`: estimation for soft regions, document+liveness for strict ones. Store only the **pass/fail + provider ref + expiry**.

### Reuse what's built
- **Block/report** is partly built: `fans.blocked_at`, `creator_reports`, admin queue (mig `0012`). Extend into a moderation workflow (status transitions, actioned-by, link to `content_records`).
- **Webhooks** (`fireWebhooks`, index.ts:3325) become **moderation hooks**: fire to a CSAM/scanning vendor on media upload; quarantine on positive.
- **Provably-fair** (`getSpinVerification`, index.ts:3209) is already a trust/tamper-evidence story — fold into the compliance marketing narrative.

## Legal table-stakes vs. premium differentiators

| Item | Classification |
|---|---|
| Real age assurance on regulated traffic | **Table-stakes** (once creator #2 / regulated regions) |
| Per-jurisdiction gating | **Table-stakes** (where laws apply) |
| Private bucket + signed/expiring URLs | **Table-stakes** the moment you host *other people's* media |
| CSAM/illegal-content moderation hooks | **Table-stakes** (platform liability) |
| Data-privacy / retention policy + deletion | **Table-stakes** (GDPR/CCPA) |
| **Forensic watermarking + leak tracing** | **Premium differentiator** |
| **2257-style records vault** (audit-ready) | **Premium differentiator** (esp. for agencies) |
| **Chargeback/dispute evidence packs** | **Premium differentiator** (provable fulfilment from `spins`+`redemptions`+age-verify) |
| **Reusable verified-age credential** across creators on the platform | **Premium differentiator** + network effect |

## Phased build

| Phase | Scope | Trigger / Effort |
|---|---|---|
| **A — "Don't get burned" baseline** | Flip `prize-photos` to **private** + server-signed expiring URLs + `media_access_log`; harden block/report into a real moderation queue; write a data-retention + deletion policy and a deletion routine. | At **creator #2** / **S–M** |
| **B — Real age assurance + vault** | Integrate one provider (Yoti default), `age_verifications` + `compliance_policies` per-jurisdiction gating replacing `acked_at`; stand up `content_records` 2257-style vault; CSAM scanning hook via webhooks. | Regulated traffic / on-platform media / **L** |
| **C — Premium moat** | Forensic watermarking + leak tracing; `dispute_packs` one-click chargeback evidence (assemble spins + age-verify + fulfilment + acks); agency-wide audit export; reusable cross-creator age credential. | Payments on-platform / disputes / **L** |

## Key risks & hardest parts
1. **Storing PII you don't want.** The cardinal rule: **never** persist raw ID documents — only provider pass/fail + reference. Mishandling verification PII creates *more* liability than the checkbox you replaced.
2. **Migrating the public bucket without breaking live links.** `prizes.image_url` and `spins.prize_image_url` are public URLs today; switching to signed delivery touches the fan spin page, share cards (`/share/[shareId]`), and verify pages — all must move to a signing endpoint atomically.
3. **Fans aren't auth users.** Age verification must bind to a `fan_id` via the service-role server path (like all fan writes), and the signed-URL issuance must happen server-side keyed to the fan's pass token — not in the browser.
4. **Watermarking is genuinely hard.** Per-fan overlay is easy; *robust* steganographic tagging that survives screenshotting is a real project — ship visible per-fan watermark first, treat invisible forensic marks as R&D.
5. **Jurisdiction logic changes fast.** `gated_regions` must be config-driven, not hardcoded; the legal map (UK OSA, US state laws, EU) shifts quarterly.
6. **Don't over-build during the pilot.** Premature compliance burns the runway the user explicitly wants to protect. Honor the triggers.

## Success metric
Pre-revenue (the right framing while deferred): **"compliance-ready" conversions** — share of *serious* creator/agency prospects who cite verified-age/leak-resistance/evidence-packs as a deciding factor (track in sales notes). Post-launch: **% of regulated-region fans age-verified before first spin**, **leak-trace resolution rate**, and **chargeback win rate** with evidence packs vs. without.

---

# Sequencing recommendation across all three

**Build order: Autopilot (2) → Agency console (1) → Compliance (3).** Rationale:

1. **Autopilot first.** It's pure upside on the *current* single-creator pilot, needs **no new compliance or org work**, and is mostly a smart read-layer over getters that already exist (`getCreatorCrm`, `getEngagementHeatmap`, `getPrizeRoi`, `getMetricsExtra`). It makes the one live creator more successful *now* — the best possible signal before scaling — and its execution flows (DM templates, happy-hours, wheel editor) are all built. Lowest risk, fastest payback, and it produces the engagement data that later justifies the other bets.
2. **Agency console second.** This is the revenue-scaling bet, but it's the **riskiest engineering** (RLS rewrite). Do it once you have ≥2 creators wanting to be managed together — which is also **Compliance Trigger 1**. Build the org layer and the *baseline* compliance items (private media, moderation) in the same push, because the moment you onboard creator #2 you are managing other people's audiences and content.
3. **Compliance last (but its Phase A rides with Agency).** Most of it is the deferred differentiator. Split it: **Compliance Phase A** (private bucket, signed URLs, moderation, retention) ships *alongside* Agency Phase A/B at creator #2; **Phases B/C** (age assurance, 2257 vault, dispute packs, watermarking) wait for regulated traffic / on-platform payments.

```
Now ──► Autopilot A/B (solo creator wins)
         │
Creator #2 / first agency ──► Agency A/B  +  Compliance A (private media, moderation)
         │
On-platform payments / regulated traffic ──► Agency C (billing)  +  Compliance B/C (age verify, vault, dispute packs)
```

## Dependencies on the Phase 7 hardening work (`0012_hardening_growth`)

Phase 7 is a **prerequisite**, not a parallel track, for Bets 1 and 3:

- **Durable spin rate-limit in `claim_spin`** (mig `0012`) — must stay correct under the agency "acting-as" and service-role paths; Autopilot's "schedule a drop" (happy-hour) interacts with the same spin path. Any Autopilot/agency change to spin flow must preserve the rate-limit semantics.
- **Block / report / self-exclude** (mig `0012`) — the literal foundation of **Compliance Phase A** moderation. Compliance extends `creator_reports` and `fans.blocked_at` rather than reinventing them.
- **`creator_reports` admin queue** must generalize to an **org** queue under Bet 1 (today it's `is_admin()`-only; agency owners need scoped visibility).
- **Public slug / link-in-bio** (`profiles.public_slug`, mig `0012`) — Autopilot card 9 ("pour fuel on a converting campaign") and agency onboarding both lean on the public share surface; it must be stable first.
- **Gated signups** (mig `0011`, `approval_status`) — the agency invite/onboarding flow (Bet 1 Phase C) builds directly on the existing approval queue and `/api/admin/invite`.

**Net:** finish/stabilize Phase 7 (rate-limit, block/report, slug) → ship **Autopilot** on the solo creator → at creator #2, ship **Agency A/B + Compliance A together** → defer **Agency C + Compliance B/C** until payments/regulation force them.
