# Independent static review of 0073 (reviewer read orch/fixes 3169542; line numbers = 0073 at that commit)

H1 (HIGH). CC-08 stale decline wipes token_hash → permanent "conflict" (L467-471).
The update sets state='declined', error='stale', …, token_hash=''. get_spin_attempt_status (L1038) and prepare_spin_attempt (L1064)
compare a.token_hash with the token digest FIRST and answer `conflict`. A fan whose commit failed / page closed between prepare
and commit keeps the request id in browser storage (src/components/fan/spinIntent.ts:113). After the nightly retention ages the
attempt out, /api/spin/status answers 409 conflict, classifySpinStatus keeps the intent (spinIntent.ts:145-147), useSpinRecovery
stays pending (:73-77), and a retry through /api/spin hits prepare → conflict → spin_pending (spinAttempts.ts:161-167): the fan
can never play that link in that browser again. Fix: drop `token_hash = ''` from the L469 update (keep context = null); the
90-day scrub at L462 clears it later. Same shape pre-existing: the 90-day scrub (L462-464) gives `conflict` for an intent saved
longer than 90 days → make status/prepare answer a terminal decline (not conflict) for an attempt whose hash was scrubbed.

M1. _stamp_actor_attribution undoes ON DELETE SET NULL (L1495-1525). BEFORE UPDATE does new.actor_id := old.actor_id
unconditionally (L1506 messages; L1513 redemptions when status unchanged). The FK's SET NULL is an ordinary UPDATE that fires
this trigger, so the NULL is reverted and the row keeps an actor_id pointing at a deleted profile (FK silently violated; dump/
restore fails). Fix: keep NULL when the old actor no longer exists, as _guard_creator_immutable does (L62-63).

M2. DB-03: a CHECK left NOT VALID (warning at L209) is still enforced on every UPDATE of the row. One legacy fan with notes > 2000
or display_name > 80, or a prize description > 1000, makes every commit touching that fan row / that prize's stock fail 23514
(fan loops in spin_pending). No pre-check exists.

M3. Lock shape heavier than the header says; no lock_timeout (header L10-20). One transaction: ACCESS EXCLUSIVE from ADD
CONSTRAINT/ADD COLUMN on fans, prizes, wheels, profiles, campaigns, orgs, fan_passes (L1017), messages and redemptions
(L1495-1497), creator_notices; ACCESS EXCLUSIVE from DROP/CREATE POLICY on messages, redemptions, grants, spin_attempts; SHARE
ROW EXCLUSIVE from CREATE TRIGGER on every creator_id table (L75 loop, alphabetical: different order from a play); SHARE from six
index builds (L1804-1809). A long/idle-in-transaction session on spins stalls the whole app behind the migration.

M4. The DB-07 pre-check in docs (convalidated query) is useless at 0038 (the constraints do not exist yet). If LIVE holds a
negative value, 0052 drops its CHECK with a warning (0052 L311-323), 0039–0072 commit, then 0073 raises: LIVE left at 0072
mid-release.

L2. `[^[:print:][:space:]]` in set_chat_settings / set_creator_note (L222-223, L241) depends on server ctype; under C locale all
non-ASCII is refused; on hosted, newer emoji may be refused 22023. set_display_name's `[[:cntrl:]]` minus tab/newline (L280) is safer.

L3. record_fan_ack locks the fan (L1620), then takes the creator's profile key share via the evidence insert FK (L1632):
reverse of 0071 F6 (profile → fan). Fix: `perform 1 from public.profiles where id = p.creator_id for key share;` before the fan lock.

L6. reset_creator_content (L600-614) deletes fans before locking the games; scrub_fan_traces (L367-372) takes redemption row
locks then, while set_redemption_state takes wheel → prize → redemption (L899-902). Fix: move the wheels FOR UPDATE (L611)
above the delete (L605). The single-fan delete has the same pre-existing shape.

L7. _reserved_name (L258-271): bypassable in display names with zero-width / non-ASCII separators or homoglyphs ("Fan<ZWSP>Funnel",
U+2011). Org names (shown in invitations and notices) are not checked at all.

L8. _org_owner_state (L2147-2175): notice only on is_active true → false (L2160). Approval withdrawn freezes every seat with no
notice; re-activation neither notifies nor removes the old notice.

L9. Closing check (L2325-2365) lacks cheap assertions: dropped overloads really gone (to_regprocedure(...) is null for each old
signature, e.g. delete_wheel(uuid), the 7-arg queue); every SECURITY DEFINER function's search_path ends in pg_temp; every public
table has RLS + ≥1 policy and no policy qual is literally true; has_column_privilege('authenticated','public.fan_passes','token',
'SELECT') is false; authenticated lacks UPDATE/DELETE on prizes, INSERT/UPDATE/DELETE on spins, INSERT/DELETE on profiles; the
zz trigger is enabled and bound to _guard_creator_immutable; a summary of DB-03 rules not in force.

INFO. legal_terms_notice readable by every session incl. announced_by (admin profile id) (L1549, L1557-1558); orgs_tie_read
(L2192-2200) exposes all org columns (owner_id, billing_model) to managed creators → column grants. creator_obligations
(L1763-1768) and creator_fan_summaries (L1874-1876) count an expired link as active. Comment L623-626 overstates the lock set
(not focuses reached through prize_id). (8) `alter function … set search_path` (L1949-1956) fails if a function is owned by
another role: unverified on hosted. WG-02 backfill (L1447-1449) gives every agency owner an owner seat = full can_act_for on
member creators without a new consent step (deliberate; owner/lawyer question).
