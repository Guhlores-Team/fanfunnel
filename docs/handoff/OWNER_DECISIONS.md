# Owner decisions — redesign parity + backlog (2026-10-26)

Principle: the redesign keeps EVERY feature/control the prior (main) dashboard had, plus every
feature added since. Item IDs (P#) refer to the placement interview, which was a scratchpad
working file (`.../scratchpad/placement-interview.md`, see `PHASE2_BRIEF.md`) and was never
committed. The decisions below are self-contained; the P# numbers are labels only.

## Placement interview
- Sign-offs: all 19 "as built = prior" items accepted (P2 P3 P13 P14 P15 P19 P20 P24 P25 P29 P31 P37 P39 P41 P45 P46 P50 P51 P54).
- P43/P44 link-in-bio: editing form (+ personal note + live preview) stays in **Settings › Public page**. Boosts shows a read-only card: link, Copy, and a jump to edit.
- P52/P53 admin: a section inside the dashboard shell (server-gated, is_admin()); creator rows show counts; role + feature flags in a disclosure.
- P1/P5/P6 first-run: build RD-5 "Your first steps" (5 steps) inside Today; new creators land on Today; "Get started" re-open in the sidebar footer.
- P17/P18 fulfilment: notes, due date and Cancel prize inline on each row (prior), restyled.
- P21/P22/P23 wheel editor: ⋯ menu for rare actions but "Set active" visible; Schedule card always visible; win description visible, emoji chips under "More".
- P32/P33/P34 fans: row actions move into the drawer (spec); tags as read-only pills on ALL screen sizes (edit in drawer); campaign names in the row meta line.
- P38/P40 analytics: restore the daily spins/revenue sub-lines; funnel = third card in the trend row.
- P7 bell: WIRE NOW — real in-app notifications in RD-7 (new wins to fulfil, new messages, low stock, others from the spec); bell shows unread count.
- P8 search: searches fans.
- P10 snooze as text button; P11 label "Today" as UTC; P26 in-app unsaved-changes dialog; P48 brand colour editable in Settings and Wheels; P49 Settings "Handle" = read-only @slug.
- P4: retire the "N prizes waiting" banner; Fulfilment sidebar badge + Today tile.
- P9: build the mobile bottom tab bar + "More" (RD-6). P12: restore drawer "Message" → opens that fan's Inbox thread.
- Carry-overs (no decision needed): P16 (#65), P35 (#64/#54 grant preview into redesigned drawer), P36 → exact per-wheel preview (h), P42 (#66), P47 (#68 copy), P55 (#73/#74), P27/P30 keep, P28 server rules (a).

## Open owner decisions (collected 2026-11-05, batch 4 on `orch/fixes`)
Each of these is either an agent-made choice the owner should confirm or a product call nobody
but the owner can make. Nothing below blocks the TEST push; the "go" can come with answers.
1. **Safety reports are kept when a creator closes its account** (0068): a suspended account or one with an
   open report cannot self-close; reports outlive the account with a non-PII snapshot. Confirm or reverse
   (`docs/DATA_RETENTION.md`, `docs/LEGAL_NOTES.md`).
2. **The fan data export excludes the creator's private notes and tags** about the fan (0068). Confirm;
   including them is a small change.
3. **Seats and creators join an agency only by accepting an invitation** (0068): no silent seating, uniform
   "ok" answers, 20 invitations per org per hour. Confirm the consent model and the limit.
4. **A "Start an agency" entry in Settings**: today the Agency page is linked only for creators who own, hold
   a seat in or belong to an agency; others reach `/agency` by URL. Add an entry, keep it hidden, or gate it
   on a feature flag?
5. **"To fulfil" count semantics** (QA pass 2026-11-04): the Today tile, the Fulfilment badge and "all clear"
   count only `pending` wins, so a win drops out as soon as it is started. Keep, or count in-progress wins as
   waiting too (touches the overview query, the demo store and alert semantics)?
6. **"Spin" as the credit word on scratch and bingo fan pages** ("Spins left", the footer, the welcome note):
   kept because "spin" is the credit unit across the product and the Terms. Keep, or rename per game kind?
7. **The Vercel Toolbar under the enforced CSP**: `script-src` allows only the app's own (nonced) scripts and
   `frame-src` is `'none'`, so the Toolbar's `vercel.live` script and iframe are blocked on every page.
   Keep it blocked (recommended for Production), or allow `https://vercel.live` on Preview only?
8. **Pausing a fan link is permanent** (batch 6, T3). Default taken: pause stays permanent; the
   pause dialog, confirmation, fan page and Terms say so plainly and warn to copy codes first, and a
   paused link shows a read-only "Your wins" view (prize, date, delivery state, an already revealed
   reward, verify link, Safety menu) instead of a 404. Reversing it needs a fan-consented new link
   and a migration that clears `self_excluded_at`.
9. **Self-close is blocked while prizes are owed** (batch 6, T4). Default taken: `POST
   /api/account/close` refuses with 409 `prizes_owed` while any of the creator's redemptions is
   pending or in progress; Settings › Close my account says why and links to Fulfilment. An admin
   delete is unaffected. The alternative is an explicit "I accept I still owe these" acknowledgement.
10. **Fans see each win's delivery status** (batch 6, T5). Default taken: the fan page, the paused
   view and the fan export show waiting / in progress / delivered (with its time) / cancelled from
   the existing redemption status. There is no cancel timestamp (no new columns), so a cancelled
   win shows when it was won. Reversing it hides the list; nothing is stored differently.

## Backlog decisions
- a: server enforces wheel rules (≥2 prizes, non-empty names, ≥1 prize with tickets > 0).
- b: trigger Codex reviews on the ~11 older PRs that never had one.
- c: delete /api/referrals/overview (dead after #73).
- d: 409 `email_taken` in the admin invite flow.
- e: prod wheel "Sexy Summer Spins" (inactive, 14/15 prizes at 0) — leave data; creator re-balances.
- f: keep /c ISR 60s; add revalidatePath on wheel and display-name changes.
- g: keep #72's extra CAS guard.
- h: exact per-wheel grant-edit preview (getFanDetail returns each grant's pass balance).
- j: bump supabase/setup-cli.
- DEBT-2 before testing; backlog must be EMPTY before the owner tests.
- Branch cleanup: delete the 21 archived branches + each PR branch once merged.
- NEXT_PUBLIC_ENABLE_DEBUG=1 set for Preview only (error console via ?debug=1, admin).
- 0068 (made by the agent, owner to confirm): safety reports about a creator are kept when the
  law requires it — they survive the deletion of the reported account with a non-PII snapshot
  (display name, public slug, deletion time; no e-mail, no link token), and a suspended account
  or one with an open report cannot close itself (an admin delete still works). Reports are
  never deleted by age; the owner decides per report. `docs/DATA_RETENTION.md`, `docs/LEGAL_NOTES.md`.
- 0068 (made by the agent, owner to confirm): the fan export keeps excluding the creator's
  private notes and tags about the fan (the creator is the controller of those; the fan asks
  the creator). Reasoning in `docs/LEGAL_NOTES.md`; adding them is a small change if reversed.
- 0068 (open): fan consent (leaderboard opt-in, board name, terms acknowledgement) is now
  fan-only in the database, but the creator holds the link token and could act as the fan;
  binding consent to a device needs fan accounts or e-mail confirmation. Lawyer / owner call.
- 0068 (made by the agent): agency seats and creators join only by accepting an invitation
  (`org_add_member` now sends a seat invitation; the owner may still seat itself directly), the
  senders answer "ok" for any address (no account enumeration), 20 invitations per org per hour.
