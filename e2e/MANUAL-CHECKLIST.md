# Manual TEST alpha acceptance checklist

The automated suites cover the clickable UI in **mock mode** (`npm run e2e`,
`npm run e2e:a11y`) and the database rules against the **test** project
(`npm run e2e:supabase`, the CI `supabase` job). These items need a human, a real
device, or a real Supabase + Vercel deploy.

**Where to test:** the Preview, https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app.
Record each item as **NOT RUN**, **PASS** or **FAIL**, with date, device and the
verified Preview revision. An unchecked box is **NOT RUN**. Prepared source, mock
browser checks and CI do not establish a real-device pass. Only start feature
sections after the engineer confirms that their migrations, feature gates and
exact verified code are on this TEST Preview. Use disposable TEST accounts, fans,
photos and dummy rewards; never use real inventory or real customer data.

Every page there shows a teal **PREVIEW · TEST database** badge. If the badge is red, stop: the
Preview is pointed at the live database (see `docs/ENVIRONMENTS.md`).

> **Error console:** while signed in as an admin, add `?debug=1` to any URL. If anything
> throws, press **Copy errors** and paste the block into the bug report. Fan spin-link tokens
> are redacted in it.

## 1. Creator, on disposable TEST data (Preview)
- [ ] **Sign up → approval → sign in.** A new account lands on the pending page until an
      admin approves it, then lands on **Today** with "Your first steps".
- [ ] **Password reset email** arrives and the link works. This needs custom SMTP in Supabase.
- [ ] **Change email** asks for your current password. **Change display name** updates the
      sidebar immediately.
- [ ] **Games** (called **Wheels** before the game rollout):
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
- [ ] The bottom tab bar (Today / Inbox / Games / Fans / More; older Preview revisions say Wheels) switches sections. **More**
      opens a sheet with the rest.
- [ ] **Sign out from More** works, including with unsaved wheel edits: it asks first.
- [ ] The fan details sheet closes by dragging its handle down, by Close, and by the back
      gesture, if your phone has one; report what happens.
- [ ] Toasts, the wheel's Save bar and the bell panel sit above the tab bar, not behind it.
- [ ] **iOS safe area / notch:** content clears the status bar and the home indicator. No
      sideways scroll anywhere. No zoom on input focus.

## 3. Fan experience (real phone + headphones)
- [ ] **Age gate:**
  - the Terms and Privacy links open in a new tab and show the current legal copy;
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

## 4. Final TEST smoke test (writes disposable TEST data)
This retains the original sign-in/play/fulfilment smoke scenario on the authorized
TEST environment. It does not approve Production, data copying or a merge to main.

- [ ] Sign in on [the TEST dashboard](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard).
- [ ] Open each dashboard section; the teal TEST badge remains visible.
- [ ] Open a disposable TEST fan link created in Fans.
- [ ] Play once; exactly one credit is used and a win appears.
- [ ] Fulfil that TEST win in the creator dashboard.

## 5. Load / concurrency (optional)
- [ ] Many fans playing at once never double-spend (the current atomic play/finalization path). Run it
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


## 8. Prerequisites and acceptance record for the new features

1. Open [the stable TEST dashboard](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard) and confirm the teal **PREVIEW · TEST database** badge.
2. Ask the engineer which numbered release and exact revision is verified on that URL; mark unavailable feature sections **BLOCKED — not deployed**, not passed.
3. Ask the engineer to prepare disposable TEST creators, a second TEST admin, two fans, dummy reward codes and a ready Bingo fixture; no real-value inventory is needed.
4. Keep this checklist private; report only a failing step and redacted error details, never a fan link, downloaded export, code, password, key or authenticator secret.

The owner has already confirmed FanFunnel admin two-factor enrollment. The checks
below verify sign-in and recovery; they do not request repeated enrollment or
removal of the owner's factor. Advanced failure/concurrency fixtures are prepared
by the engineer; the owner does not need a terminal or database editor.

## 9. Privacy, export, deletion and two-factor sign-in

- [ ] 1. Open [Settings](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=settings) as the disposable TEST creator.
- [ ] 2. Select **Download my data**; save the file privately and check that it belongs only to that creator, including any agency invitation expiry information.
- [ ] 3. Open **Safety & privacy** on one disposable TEST fan link.
- [ ] 4. Select **Download my data** there; the private export belongs only to that fan and honestly reports any unavailable section.
- [ ] 5. Select **Delete my data** on that fan; read the explanation before proceeding.
- [ ] 6. Complete **Delete my data permanently** using only the disposable fan; its link loses play, chat, wishlist and private reward access, including on reopening.
- [ ] 7. Open **Close my account…** in Settings on a separate disposable TEST creator.
- [ ] 8. Complete **Permanently close my account** with that disposable creator's website confirmation; old fan links stop working and other creators remain unaffected.
- [ ] 9. Sign in to [TEST Admin](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/admin) in a fresh private browser; an admin must verify an authenticator code before admin access.
- [ ] 10. Verify that code only on [the TEST authenticator page](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/mfa?next=%2Fdashboard%3Fsection%3Dadmin&reason=admin); the authenticator app generates it automatically, and it is never sent in chat.
- [ ] 11. Repeat a fresh sign-in using a disposable creator that enrolled two-factor; business access requires verification while a creator without an enrolled factor retains the optional flow.
- [ ] 12. When the engineer's TEST recovery fixture shows **Verify with your authenticator (new tab)**, follow it; it opens only the TEST site and asks for the code there.
- [ ] 13. Return to the original form after verification; password fields are cleared and no sensitive change submits itself.
- [ ] 14. Re-enter needed credentials on the website and deliberately submit the original action once; an unresolved economic request must keep its original request identity.

A verified session can stay verified until sign-out or session expiry; this is not
a code prompt for every click. FanFunnel's recovery path is another verified admin
resetting a factor; do not assume that provider recovery codes are FanFunnel codes.
Deletion removes private reward ciphertext and hints; anonymous financial records
and code non-reuse fingerprints may remain as described in Privacy. The engineer
must separately verify that retained records cannot reveal or recreate the secret.

## 10. Installed iPhone dashboard and push notifications

Prerequisites: real iPhone on iOS 16.4+, Preview push configured, and the dashboard
installed as described in §6. These are **NOT RUN** until tried on the real phone.

- [ ] 1. Open [the TEST dashboard](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard) in iPhone Safari.
- [ ] 2. Use Safari **Share** → **Add to Home Screen** to install the creator dashboard.
- [ ] 3. Open the new **FanFunnel** home-screen app and sign in there.
- [ ] 4. Open [Settings](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=settings) inside the installed app.
- [ ] 5. Turn on **Push to this device** and allow notifications in the phone's permission prompt.
- [ ] 6. Leave **Show names and prizes on lock screen** off for the privacy check.
- [ ] 7. Select **Send a test**; a real notification arrives with generic activity text.
- [ ] 8. Tap that notification; it opens the correct TEST dashboard location.
- [ ] 9. With the dashboard closed, have the engineer trigger a disposable TEST win or message; the relevant alert arrives once and its tap reaches the matching item.
- [ ] 10. Turn on **Show names and prizes on lock screen** only if wanted; the next test follows that explicit choice.
- [ ] 11. Turn **Push to this device** off; a subsequent test does not arrive on that device.
- [ ] 12. Repeat the permission/test/tap checks on a real Android installation.
- [ ] 13. Have the engineer's blocked/paused/on-break fan fixture trigger an otherwise eligible event; it must not create a prohibited engagement notification.

Push permission is per device. Safari-tab success does not establish installed
iPhone push success. Denied permission should show useful guidance without a
repeat prompt loop; record the phone's actual behavior. Never rotate push keys as
a troubleshooting shortcut because existing subscriptions depend on them.

## 11. Instant rewards using dummy inventory only

Prerequisites: two Preview reward keys backed up privately, compatibility canary
healthy, and engineer-created dummy code/text/link fixtures. Real inventory waits
for the key backup/restore and diagnostic gates in OWNER_STEPS.

- [ ] 1. Open [Games](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=editor) and review the prepared dummy instant prize; code stock follows available codes rather than a freely editable quantity.
- [ ] 2. Win the prepared dummy code on its disposable fan link; exactly one credit is used and the private reward appears.
- [ ] 3. Select **Copy code**; the clipboard contains that dummy code only.
- [ ] 4. Reopen **Your wins** → **View reward**; the same saved reward appears without another credit or replacement code.
- [ ] 5. Reload the fan link and reopen that history item; the original reward remains available.
- [ ] 6. Open the public share/verify link in a separate private browser; neither page displays the private code, text or reward URL.
- [ ] 7. Open the creator's fulfilment view; the instant win is **Auto**, and **Viewed by fan · N×** increases after a re-view without disclosing the secret.
- [ ] 8. Win the prepared dummy external-link reward; **Open reward ↗** explains the destination and opens a new tab only on selection.
- [ ] 9. Delete this disposable fan's data through **Safety & privacy**; old private reward links and history no longer reveal the code.
- [ ] 10. Ask the engineer to verify erasure of ciphertext/hints and refusal to reimport the same erased dummy code; record the redacted result, not the code.

Stock drift behavior: a recoverable sold-out candidate is excluded by a recorded,
replayable redraw from the committed pool. An unrecoverable held-stock or reward-key
failure refuses before debit. The older proposal's manual-pending fallback is not
implemented; this checklist must not claim that a refused play created a win.

## 12. Creator themes, photo moderation and readability

- [ ] 1. Open [Settings](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=settings) → **Look & feel**.
- [ ] 2. Choose a **Headline font** and **Background**; the preview updates and body text stays readable.
- [ ] 3. Select **Save look & feel**; reloading preserves the chosen appearance.
- [ ] 4. In **Photo hub**, select **Choose photo** with a harmless safe-for-work TEST image that you may publish.
- [ ] 5. Enter **Caption and image description (optional)**; the text accurately describes the image.
- [ ] 6. Tick the public-sharing/safe-for-work confirmation only if it is true.
- [ ] 7. Select **Upload photo**; the processed public image appears without location metadata (engineer verifies removal separately).
- [ ] 8. Use **Move earlier** or **Move later** on a two-photo fixture; the saved order survives reload without dragging.
- [ ] 9. Choose **Background photo** and save the appearance; text and buttons stay readable over both light and dark photo areas.
- [ ] 10. Edit an uploaded caption and select **Save description**; the changed public description survives reload.
- [ ] 11. On a spare disposable image, select **Remove photo**; its confirmation is clear.
- [ ] 12. Select **Remove permanently** for that image; it disappears, and removing a background image returns the background to Glow.
- [ ] 13. Open the public-page link shown in Settings; its headline, background, captions and gallery match the saved settings and expose no private fan link.
- [ ] 14. Open a disposable fan link on the phone; its theme matches the creator while its game keeps its own brand color.
- [ ] 15. Check the fan page with larger phone text and reduced motion; controls remain readable, reachable and free of sideways scrolling.
- [ ] 16. As a TEST admin, select **Remove photos** on the disposable creator fixture; the confirmation names the intended creator.
- [ ] 17. Select **Confirm remove all photos** only for that fixture; its public gallery disappears, its photo background returns to Glow, and other creators' photos remain.
- [ ] 18. Ask the engineer for the measured themed **Preview LCP** result on the controlled photo/font fixture; record conditions and result here before marking performance verified.

The LCP measurement is **NOT VERIFIED** by this document or by local unit/axe checks.
Photo moderation/cleanup and account deletion may refuse restoration while cleanup
is unresolved; no success should be claimed before the final server outcome.

## 13. Focus first; Chase remains off until its separate gate

Prerequisites: verified 0059 Preview, saved Focus preset and Boostable TEST prize.
A below-cost or unknown-cost preview needs a deliberate owner review; unknown cost
must never be described as zero. Chase is **HOSTED OFF**, including after a passing
Focus check, until Focus soak evidence and one approved TEST-creator allowlist.

- [ ] 1. Open [Campaigns](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=campaigns) and review the saved Focus preset's price, multiplier, duration and cost warning.
- [ ] 2. Open [Fans](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=fans) and select the disposable fan with a saved pass.
- [ ] 3. Open **Focus & Chase packs** → **Choose a Focus pack**.
- [ ] 4. Choose the **Saved pack**, target prize and saved pass; review the displayed grant before confirming.
- [ ] 5. Tick **Confirm this saved pack, target, pass and recorded price.** only after reviewing those details.
- [ ] 6. Select **Grant Focus pack** once; its status appears without duplicate credits or a second active pack.
- [ ] 7. Open that fan's link; **Focus on …**, remaining focused spins and the prize book describe its current odds.
- [ ] 8. Play once; one credit and one eligible focused spin are consumed, and the win's verify page replays the recorded odds.
- [ ] 9. Use the engineer-prepared sold-out/ineligible target fixture; the pack reports its pause and keeps focused progress while ordinary permitted play still wins.
- [ ] 10. Put the disposable fan on a break; fresh play is blocked and focused progress is kept.
- [ ] 11. In fan details select **Cancel pack**; read that this releases unused reservation without removing granted spins or refunding the fan.
- [ ] 12. Select **Confirm cancel pack** only for this disposable fixture; a refresh shows the matching pack cancelled.
- [ ] 13. Verify Chase cannot be granted to an unapproved TEST creator; the UI explains **Chase grants are disabled until this creator is enabled for the TEST pilot.**

Only after the engineer records Focus soak and the owner approves **one TEST
creator** may the separate Chase pilot start. Keep broad Chase disabled. Pilot
acceptance must cover the reserved prize, eligible-progress count, exact guarantee,
break/stock pauses, cancellation release, concurrency and replay, with healthy
reservation diagnostics. This document does not enable or approve that pilot.

## 14. Scratch tickets (feature-gated TEST creator)

- [ ] 1. Ask the engineer to confirm **Scratch Tickets** is enabled only for the intended TEST creator in [Admin](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/admin).
- [ ] 2. Open [Games](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=editor) and its **Create a game** dialog.
- [ ] 3. Choose **Scratch ticket** and select **Create game** with disposable prizes.
- [ ] 4. Open its disposable fan link; each credited ticket wins and the displayed cost is one credit.
- [ ] 5. Scratch a ticket; exactly one matching triple reveals the committed prize, without fake nearly winning triples.
- [ ] 6. On another ticket, select **Reveal all** using the keyboard or phone; it reveals the same committed result without requiring a scratch gesture.
- [ ] 7. Reload after a committed result; recovery shows that ticket rather than charging for another.
- [ ] 8. Open its verify link; **Hash matches** is accompanied by the replayed ticket and winning prize, with no private reward value.
- [ ] 9. Have the engineer disable new Scratch creation for this TEST creator; existing paid links and same-kind edits continue while new disabled types cannot be created.

## 15. Personal Bingo (separate feature-gated TEST creator)

Prerequisite: verified 0061 Preview and an engineer-prepared ready/near-line/full
card fixture. A local file or a passing Scratch release does not enable Bingo.

- [ ] 1. Ask the engineer to confirm **Bingo** is enabled only for the intended TEST creator in [Admin](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/admin).
- [ ] 2. In [Games](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=editor), choose **Bingo** in **Create a game**.
- [ ] 3. Select **Create bingo draft**; the incomplete draft cannot be used as a paid fan game.
- [ ] 4. Review the engineer's nine eligible prizes, unlimited rare-or-better fallback, **Line prize** and primary-plus-bonus cost preview before saving the ready fixture.
- [ ] 5. Open a disposable fan link; **Your personal bingo card** explains that every play wins its drawn prize.
- [ ] 6. Play once; exactly one credit is used and the ordinary prize is won even if it repeats a marked square or is outside the card.
- [ ] 7. Complete the prepared line fixture; **Line complete!** adds its bonus with no extra credit, paid-play count or recursive bonus.
- [ ] 8. Select **Verify this line bonus**; the proof ties it to the same parent play and committed card transition.
- [ ] 9. Reopen a dummy instant line reward through **View bonus reward** or **Your wins**; the same private reward returns without new play.
- [ ] 10. Open a second disposable fan's link; it has its own card and cannot change the first fan's progress.
- [ ] 11. Reload after a completed card; it stays complete until the next credited play starts a new card and wins its ordinary prize.
- [ ] 12. Review the creator's analytics/fulfilment for this fixture; bonuses count as rewards and costs, while paid plays and engagement count only primary plays.

## 16. Unknown outcomes, cancellation and security recovery

Prerequisite: the engineer creates safe TEST interruption fixtures. Do not clear
browser storage, switch browsers or create another economic request to guess
whether the first one finished. Missing/unknown does not mean safe to retry anew.

- [ ] 1. On an interrupted fan play, select **Check this spin**; a committed result returns without another debit.
- [ ] 2. If still unresolved and offered, select **Retry this same spin**; it reconciles the original attempt, not a new play.
- [ ] 3. On an interrupted creator grant/import/edit fixture, select **Check outcome**; a completed original returns **No duplicate grant was added**.
- [ ] 4. On the engineer's uncompleted fixture, select **Cancel uncompleted request**; review the confirmation.
- [ ] 5. Select **Confirm cancel request**; wait for confirmed cancellation before editing the form or creating a replacement.
- [ ] 6. If the server remains unavailable or permission is lost, leave the request unresolved and report the step; the form must not claim success or discard its recovery receipt.
- [ ] 7. When MFA recovery is offered, select **Verify with your authenticator (new tab)** and verify only on the TEST website.
- [ ] 8. Return to the original tab and use its original recovery control deliberately; no action should auto-submit on authentication.
- [ ] 9. Ask the engineer to verify last-active-admin, pending-cleanup and lost-permission refusal fixtures; a refusal has readable guidance, no mutation and no successful audit entry.
- [ ] 10. With two disposable TEST admins, rehearse **Reset two-factor** on a disposable creator only; confirm that the remaining verified admin can help recover access.
- [ ] 11. Test a prepared expired agency invitation; it cannot be accepted, and a reissued invitation is new with its own seven-day deadline.

Never remove, suspend, demote, delete or reset the owner's sole working admin as
a recovery experiment. Keep a separately verified second admin before relying on
admin-assisted recovery. Final security audits and hosted negative tests remain
engineering release gates in addition to these visible manual checks.


## 17. System health, backups, scheduling and alerts

Follow [OWNER_STEPS §4–5](../docs/handoff/OWNER_STEPS.md#4-back-up-the-reward-keys-before-any-real-inventory)
only after the engineer confirms this operations UI is deployed on the verified
TEST Preview. Exact UI: [TEST Admin](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/admin)
→ **System health** → **Refresh status** / **Run checks now**. Initialization is
separate and requires an honest private backup of both reward keys and version;
never replace an existing protection record to hide a mismatch.

- [ ] 1. Select **Refresh status**; connected status must not say **Demo only**.
- [ ] 2. After backup/initialization prerequisites, select **Run checks now**; reward-key protection and bounded inventory/reservation/credit checks both report their actual outcomes.
- [ ] 3. Ask the engineer to exercise a disposable mismatch/recovery fixture; failure is visible, secret values stay hidden and original keys are restored before recovery is reported.
- [ ] 4. Record an actual later authenticated TEST maintenance timestamp; a manual run does not prove a working daily scheduler.
- [ ] 5. Confirm receipt of a safe redacted TEST alert in the intended inbox; an Errors entry alone does not prove email delivery.

**NOT VERIFIED by this document:** scheduler (known inactive), older Preview
retirement (needs concrete approved plan), both-key/version backup, TEST restore,
second-admin recovery, real alert delivery, real iPhone/Android push and controlled
themed Preview LCP. See [the operations ledger](../docs/handoff/OWNER_STEPS.md#7-open-operational-checks--all-not-verified-here).

## 18. Safety reports, blocked fans, webhooks (audit #2, Preview on the TEST database)

Needs migration 0064 on the TEST project, `ALERT_EMAIL_TO`/`RESEND_API_KEY` set for Preview
with `ALERT_ENVIRONMENTS` including `preview`, and an admin signed in with two-factor.

- [ ] On a fan link, Safety & privacy › Report this creator › **Involves someone under 18**.
      Within a minute the Admin nav item shows a count, and `ALERT_EMAIL_TO` gets an e-mail
      naming only the reason and time (no fan name, link or details).
- [ ] Admin › **Reports**: the report is marked Urgent, names the creator, the fan and a short
      link hint; **What the fan wrote** reveals the details. Resolve it with a note: it moves to
      Resolved with the note and time, the nav count drops, and Admin › Activity logs it.
- [ ] Signed in as a creator without admin (or an admin without two-factor),
      `/api/admin/reports` answers 401/403.
- [ ] Block a fan from the Fans drawer. Their link says chat and wishlists are off, shows no chat
      or wishlist, and a chat tab left open from before shows the same note on send.
- [ ] Boosts › Webhooks: add a hook for **Wins to fulfil** pointing at a request bin. A manual
      prize win delivers it with `X-FanFunnel-Signature`; an auto-delivered win does not. Verify
      the signature with the secret shown under the hooks. A 6th hook, `http://localhost/` and
      `http://169.254.169.254/` are refused.

## 19. Games, campaigns and links (0065 per-fan games; Preview on the TEST database)

Needs migration 0065 on the TEST project. Use one disposable TEST creator with at least
two finished games of different kinds (for example a wheel called "Spin to Win" and a
scratch ticket called "Test Scratch"), one disposable campaign and two disposable fan links
in that campaign. Every game name in the dashboard is followed by a small badge that says
**Wheel**, **Scratch** or **Bingo**. The badge is the thing to read, not its colour.

**Which game is live**

- [ ] 1. Open [Games](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=editor). A box at the top says
      **Live for fans now:** with a game name, its badge, and a reason in plain words (for
      example "because it's your active game").
- [ ] 2. The game chips under it each show the right badge (Wheel / Scratch / Bingo).

**Scheduling a game takes over (with a confirm)**

- [ ] 3. Select the game that is *not* live. Under its schedule, pick an **Active from** time a
      minute ago and no **Active until**, then select **Save schedule**.
- [ ] 4. A box opens titled **Replace <live game> for fans?** It names both games with their
      badges and says campaigns that chose a game keep playing it. Select **Don't schedule**:
      nothing changes and **Live for fans now** still shows the old game.
- [ ] 5. Repeat step 3 and select **Yes, schedule it**. **Live for fans now** switches to the
      scheduled game and says your active game comes back when the schedule ends.
- [ ] 6. Open a fan link that has no game chosen for it: it plays the scheduled game.
- [ ] 7. Select **Always on** on the scheduled game to undo it; **Live for fans now** goes back.

**The campaign's game**

- [ ] 8. Open [Campaigns](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=campaigns). Each campaign shows either
      **Plays:** with a game and badge, or **Follows your live game (currently …)**.
- [ ] 9. Use **Change game** on the campaign to pick the other game. The line changes to
      **Plays:** that game, and both fan links in the campaign now play it (open one to check).
- [ ] 10. When creating a new campaign, the **Game fans play** picker offers the same choices.
- [ ] 11. Archive the game the campaign plays (in Games). Back in Campaigns, the campaign shows
       an amber line: **Set to play <game>, but it's archived, so fans get your live game.
       Pick another game below.** Open a fan link in the campaign: it plays your live game,
       not an error. Unarchive the game afterwards.

**One fan's own game ("This link plays")**

- [ ] 12. Open [Fans](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/dashboard?section=fans) and open the first disposable fan. In the
       drawer, **This link plays:** names the game, its badge and why (for example
       "(via campaign …)" or "(your live game: …)").
- [ ] 13. Select **Change game**. Under **Change game for this fan only**, pick a different
       game. The line now says "(chosen for this fan only)". Open that fan's link: it plays the
       chosen game.
- [ ] 14. Open the second fan in the same campaign: it still plays the campaign's game. Only the
       first fan changed.
- [ ] 15. Archive the game chosen for the first fan. Its drawer shows an amber line saying the
       link is set to play that game, but it's archived, so it plays the game below. The link
       still works. Unarchive the game.
- [ ] 16. Set the first fan back to **Follow campaign "…"**; it plays the campaign's game again.

**The fan sees new odds after a change ("Odds were updated")**

- [ ] 17. Open a disposable fan link on a phone and leave it open. On the dashboard, change a
       prize's weight on the game that link plays and save.
- [ ] 18. Without reloading the fan page, play once. The win card says **Odds were updated
       since you opened this page. This spin used the new odds; see them on the verify page.**
       The link opens the verify page for that play.
- [ ] 19. Play again without changing anything: the notice does not appear.

**Public pages say the right game**

- [ ] 20. With a scratch or bingo game live, open your public page (`/c/<your link name>`).
       It talks about tickets (scratch) or bingo, not a wheel or spins. Share a win from a
       scratch or bingo fan link and open the share link: the text under the prize names the
       same game.
