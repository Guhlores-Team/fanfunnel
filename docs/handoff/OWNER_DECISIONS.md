# Owner decisions — redesign parity + backlog (2026-10-26)

Principle: the redesign keeps EVERY feature/control the prior (main) dashboard had, plus every
feature added since. Item IDs (P#) refer to placement-interview.md in this folder.

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
