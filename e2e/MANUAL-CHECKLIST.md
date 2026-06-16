# Manual pre-launch checklist

The automated E2E suite (`npm run e2e`) covers the clickable UI and happy-path
flows in **mock mode**. These items can't be verified by automation — they need
a human and/or a **real Supabase + Vercel deploy**. Run through them before a
release.

> Tip: enable the in-app error console while testing — add `?debug=1` to any
> URL. If anything throws, hit **Copy errors** and paste the block into the bug.

## Real-backend (Supabase) — do these on the live/preview deploy
- [ ] **Schema is current** — ran `supabase/schema.sql` (or migration `0023`)
      so `set_chat_settings` exists.
- [ ] **Env fail-closed** — production has all three vars
      (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY`); a deploy missing one refuses to boot rather
      than serving demo data.
- [ ] **Chat settings persist** — set intro/outro in Boosts, reload, confirm
      they stuck (this silently failed in prod before the RPC fix).
- [ ] **Leaderboard toggle persists** across reload.
- [ ] **Account reset** is a true fresh start (onboarding checklist returns,
      leaderboard off, chat cleared) — and only wipes *your* data.
- [ ] **Cross-tenant isolation** — a second creator can't see/modify the first
      creator's wheels, fans, redemptions, or messages.
- [ ] **Agency** — an org member can act for their assigned creators (and only
      those). (Org features are no-ops in mock mode.)

## Payments / external integrations
- [ ] **Tip / buy-spins link** routes to the real destination (OnlyFans / tip
      provider) and back.
- [ ] **Webhooks** actually fire to a real endpoint on a `prize_pending` event.
- [ ] **Auth** — real email/password sign-up + sign-in, email confirmation
      on/off as configured.

## Sensory / device (test on a real phone + headphones)
- [ ] **Sound** — spin tick + win fanfare actually play (button shows
      "🔊 Sound on"); muting silences them.
- [ ] **Haptics** — buzz on spin/win on a physical device.
- [ ] **Avatar upload** — pick a file from the device, it uploads and appears on
      the fan page and the `/c/<slug>` link-in-bio hero.
- [ ] **Drag-reorder** prizes with a real pointer; the page auto-scrolls near
      the edges and the drop indicator reads clearly.
- [ ] **iOS safe-area / notch** — content clears the status bar; no zoom-out.

## Visual / judgment
- [ ] Brand color applied per-creator looks right across dashboard + fan page.
- [ ] No layout breakage at 320px, tablet, and desktop widths.
- [ ] Copy, emojis, and rarity colors read correctly; nothing clipped.
- [ ] QR code scans from an actual phone camera.

## Load / concurrency (optional but recommended)
- [ ] Many fans spinning at once don't double-spend (the atomic `claim_spin`
      path) — exercise against real Postgres, not mock.
