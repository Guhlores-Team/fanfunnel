# Manual alpha / pre-launch checklist

The automated suites cover the clickable UI in **mock mode** (`npm run e2e`,
`npm run e2e:a11y`) and the database rules against the **test** project
(`npm run e2e:supabase`, the CI `supabase` job). These items need a human, a real
device, or a real Supabase + Vercel deploy.

**Where to test:** the Preview, https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app.
Every page there shows a teal **PREVIEW · TEST database** badge. If the badge is red, stop: the
Preview is pointed at the live database (see `docs/ENVIRONMENTS.md`).

> **Error console:** while signed in as an admin, add `?debug=1` to any URL. If anything
> throws, press **Copy errors** and paste the block into the bug report. Fan spin-link tokens
> are redacted in it.

## 1. Creator, on real data (Preview)
- [ ] **Sign up → approval → sign in.** A new account lands on the pending page until an
      admin approves it, then lands on **Today** with "Your first steps".
- [ ] **Password reset email** arrives and the link works. This needs custom SMTP in Supabase.
- [ ] **Change email** asks for your current password. **Change display name** updates the
      sidebar immediately.
- [ ] **Wheels:**
  - save a wheel with 20+ prizes, reload, and it's all there;
  - schedule it, archive it, duplicate it;
  - set a prize's stock to 0 and confirm its odds go to 0%.
- [ ] **Fans:**
  - mint a fan link with spins and open it on your phone;
  - top up a fan and edit a past grant: the preview matches what's saved;
  - add tags and notes;
  - QR: scan the code with a real phone camera;
  - Copy DM.
- [ ] **Fulfilment:** fulfil a win, add a note and a due date, cancel a prize.
- [ ] **Inbox:** the fan messages you, you reply, and the unread badges clear.
- [ ] **Notification bell** shows the new win and the message. Opening it clears the count,
      and the count stays cleared after a reload. Each item opens the right section.
- [ ] **Boosts:**
  - a happy hour shows "boosted" on the fan page;
  - a webhook fires to a real endpoint on a new win (e.g. a webhook.site URL);
  - deleting either asks for confirmation.
- [ ] **Settings:** brand colour re-tints instantly; the public page (`/c/<slug>`) shows the
      tagline, note, avatar and tip link; the notification toggles stick.
- [ ] **Account reset** (type RESET) is a true fresh start and only wipes *your* data.
- [ ] **Admin:**
  - approve/suspend a creator;
  - role and feature flags;
  - delete an account (type its email);
  - a non-admin can't see the Admin section or reach `/admin`.
- [ ] **Agency:** an org member can act for their assigned creators, and only those.
- [ ] **Cross-tenant:** signed in as a second creator, you can't see the first creator's fans,
      wins or messages anywhere.

## 2. Phone (real device, Preview)
- [ ] The bottom tab bar (Today / Inbox / Wheels / Fans / More) switches sections. **More**
      opens a sheet with the rest.
- [ ] **Sign out from More** works, including with unsaved wheel edits: it asks first.
- [ ] The fan details sheet closes by dragging its handle down, by Close, and by the back
      gesture, if your phone has one; report what happens.
- [ ] Toasts, the wheel's Save bar and the bell panel sit above the tab bar, not behind it.
- [ ] **iOS safe area / notch:** content clears the status bar and the home indicator. No
      sideways scroll anywhere. No zoom on input focus.

## 3. Fan experience (real phone + headphones)
- [ ] **Age gate:**
  - the Terms and Privacy links open (drafts for now) in a new tab;
  - you can't play without both boxes ticked.
- [ ] **Spin:**
  - the balance goes down by one;
  - the win shows;
  - the provably-fair **verify** page says "Hash matches".
- [ ] **Sound:** spin tick and win fanfare play; mute silences them. **Haptics** buzz on spin
      and win.
- [ ] Wishlist, chat with the creator, the leaderboard opt-in, sharing a win card, and
      **Pause my link** (SPIN disables right away).
- [ ] A dead or expired link shows the branded "link not found" page.

## 4. Live site smoke test (production — read-only clicks, no test data)
- [ ] Sign in, open each section, open a fan's spin link, and spin once with a real fan
      account you control. Fulfil the win. No red badge appears (production has none).

## 5. Load / concurrency (optional)
- [ ] Many fans spinning at once never double-spend (the atomic `claim_spin` path). Run it
      against the test database, never production.
