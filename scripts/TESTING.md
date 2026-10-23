# Testing the agency flow with seeded accounts

## 1. Apply migrations
Make sure all migrations (through the latest) are applied (paste
`supabase/migrations_combined.sql` into Supabase → SQL Editor → Run).

## 2. Seed test accounts + sample data
```bash
node scripts/seed-agency.mjs
```
Needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (read from
`.env.local`). Idempotent — safe to re-run; it rebuilds sample data each time.

## 3. Accounts created — password for all: `FanFunnel123!`

| Login | Role | What to test |
|---|---|---|
| `owner@fanfunnel.test` | Agency owner | Go to **/agency** — see the roll-up, Aria's data, the pending invite for Mia, and the two staff seats. Invite/revoke creators, add/remove seats, scope seats per-creator. |
| `aria@fanfunnel.test` | Creator (in the org) | **/dashboard** + **Today** tab (autopilot cards from her real data). Her wheel/fans/revenue roll up into the agency. |
| `mia@fanfunnel.test` | Invited creator | **/dashboard** shows the **Accept / Decline** invite banner (consent gate). Accept → she joins the org and appears in the owner's roster. |
| `chatter@fanfunnel.test` | Staff · chatter | Scoped to Aria, **chat only** — should be able to view/message Aria's fans but not edit her wheel or fulfil. |
| `fulfiller@fanfunnel.test` | Staff · fulfiller | Scoped to Aria, **fulfil only** — can mark redemptions, can't chat or edit. |

## 4. Fan view
The seed prints a `/spin/<token>` link for each of Aria's fans (Nova, Luna, Rae).
Open one to see the wheel, the creator note, the prize book, and — because those
fans opted into the leaderboard with rare wins — the **recent-wins ticker**.

## 5. RLS sanity check (important)
Sign in as `chatter@fanfunnel.test` and confirm they can ONLY act for Aria, and
only via chat (no wheel edits, no fulfilment). This validates the per-command
RLS split from migration `0014`.
