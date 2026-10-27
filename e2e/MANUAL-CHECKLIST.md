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

## 6. Home-screen install (RM-4: real iPhone on iOS 16.4+ and a real Android phone, Preview)
Automated e2e covers the manifest, icons, headers and the install card in an emulated
browser. Only a real phone can show the install itself. **Setup:** in Settings › Public page ›
**Home-screen icon**, leave **Neutral** selected. In Fans, mint a fan link with at least 4
spins and send it to both phones.

**iPhone (Safari, iOS 16.4 or later)**
- [ ] Open the fan link and pass the age gate. **Before spinning**, there is no "Add to your
      home screen" card.
- [ ] Spin once and close the win. A card under SPIN reads **"Add Spins to your home screen ⭐"**.
      Tap **How**: two steps appear (Share, then Add to Home Screen).
- [ ] Follow them. Safari's Add screen proposes the name **Spins** and shows the **wheel icon in
      your brand colour**, not your photo or name. Tap Add.
- [ ] The home screen shows the wheel icon labelled **Spins**.
- [ ] Tap the icon. It opens **full screen** (no Safari bars) **straight to this fan's wheel**:
      same balance and wins, not the landing page, the dashboard or a sign-in page. The status
      bar text is readable.
- [ ] Spin inside the installed app: it works, and **no install card** appears there.
- [ ] The app switcher shows **Spins**, not your creator name.
- [ ] Back in the Safari tab, tap **Not now** on the card. It disappears. Reload and win again:
      it stays hidden (for 14 days).

**Android (Chrome)**
- [ ] Open the fan link, pass the age gate, spin and close the win. The card shows an
      **Install** button. If it shows **How** instead, Chrome hasn't offered an install: write
      down what Chrome's ⋮ menu offers ("Install app" or only "Add to Home screen").
- [ ] Tap **Install**. Chrome's own dialog shows **Spins** with the wheel icon. Install it.
- [ ] The icon on the home screen and in the app drawer is the wheel, not cut off by the
      round mask, labelled **Spins**.
- [ ] Open it. It opens in its own window (no address bar), the status bar is in the brand
      colour, and it lands on **this fan's wheel**.
- [ ] Long-press the icon › App info: it is a real app named **Spins**. If Android shows a
      browser shortcut (a small Chrome badge on the icon, no App info), report it: the
      fallback in the plan (a no-fetch worker for the fan link) is then needed.
- [ ] Install a **second** fan link the same way: it becomes a **separate** app, and each
      opens its own fan's wheel.

**Both phones**
- [ ] **Avatar choice:** in Settings, upload a photo with Change avatar, pick **My avatar**,
      Save. Mint a new fan link and install it: it proposes your **display name and photo**.
      An iPhone that already added a link keeps its old icon (Apple doesn't update them).
      On Android, note whether the existing app's icon updates within a day of reopening it.
- [ ] **Ended link:** pause the link from the installed app (footer › Pause my link), then
      close and reopen the app. It shows the branded "This link isn't active" page, no error.
- [ ] **Dashboard app:** signed in as the creator, add the dashboard to the home screen
      (iPhone: Share › Add to Home Screen; Android: ⋮ › Install app). It is named
      **FanFunnel**, has the pink wheel icon and opens on **/dashboard**. Sign out inside it,
      close and reopen it: you are asked to sign in. Nothing is shown from a cached session.

**Privacy spot check (desktop Chrome on the Preview, once)**
- [ ] On a fan link, DevTools › Application › Manifest shows name **Spins** and start URL
      `/spin/<token>?src=pwa`; Application › Service workers lists **none** for that page.
- [ ] Network tab: the manifest and icon requests show `Cache-Control: private, max-age=300`
      and `X-Robots-Tag: noindex`. View source on `/c/<your-slug>`: no `/spin/` link anywhere.

## 7. Win-back queue (RM-5, Preview on the TEST database)
Automated e2e runs the queue in demo mode by aging fans 20 days; on Preview you need fans who
really went quiet. **Setup:** migration 0051 is on the test database. Have at least three paying
fans whose last spin is 14+ days old (or ask an engineer to backdate test fans' spins/grants on
the TEST project only). Block one of them, and on another fan's link use the fan page's
"Pause my link".
- [ ] Analytics › Audience › **Win-back** lists the quiet paying fans, highest spend first. The
      blocked fan and the fan who paused are **not** listed.
- [ ] Pick a saved template under **Message** (Fans › Manage messages now lists the tokens
      `{name}` `{lastWin}` `{days}` `{creator}` besides `{link}`). Tap **Copy DM** on a row: paste
      it somewhere. Name, last win, days and your display name are filled in, and the link opens
      that fan's wheel. The row disappears and **Recently contacted** shows "Contacted today".
- [ ] **Start win-back**: the queue opens (bottom sheet on a phone, side drawer on desktop) on
      the top spender with a filled preview. **Copy & next** copies and moves on, **Skip** moves
      on, **Snooze 30d** moves on. The last screen shows the tally. Close it: copied and snoozed
      fans are gone from the list, the skipped one is still there.
- [ ] Have a contacted fan spin. Reload Analytics: their Recently contacted row says
      **Came back ✓** and the stat reads "N contacted · 1 came back".
- [ ] Today › Needs you now: the **"N paying fans have gone quiet"** card's **Start win-back**
      opens Analytics with the queue already open.
- [ ] Fans tab: **Copy link** on the paused fan says they paused their link and copies nothing;
      on the blocked fan it says they are blocked.
- [ ] Signed in as a **second** creator: none of the first creator's fans or contacts appear.
