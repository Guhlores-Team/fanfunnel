# dash builder progress (gaps/b7-dash) — DONE
Final pushed head: ccdf2584b88e8133b7ce85a922cd0e894b152e6a (orch/fixes 3527cba fully merged, tree clean).
Gate on that head: lint 0, typecheck 0; under heavy.lock: npm test 383/383 (unit6.log), debug build OK (build6.log), gate6.txt;
own server :3504 → journeys.mjs 193/193 steps, 0 signals (j-all.log); a11y dashboard 64 / agency 4 / System health 4 states, all zero (a11y-*.log).
Server stopped. Report delivered via SubagentHandback.

## Round 3 (coordinator items 1-9), branch gaps/b7-dash

Commits: 84c58e3 (merge 684b375), b2f9a39, 51aa6fb, e41ee67 (merge df07f86, docs only).

1. Unlock request authz: can_act_for(self,'manage') === true before any service call (gameUnlock.ts:117-118), atomic dedupe by derived primary key + ON CONFLICT DO NOTHING (gameUnlock.ts:73, :97-100). actorNames proves can_act_for itself (actorNames.ts:49) before cache and service read; callers analytics.ts:138, inbox.ts:424, redemptionQueue.ts:133.
2. PR-10 shows in real mode through the column-gated read (publicProfile.ts:208-211); 23514 -> invalid_delivery_days (publicProfile.ts:337). No seat UI has the control.
3. PR-13 expiry shows in real mode through the tolerant fan_passes read (fans.ts).
4. Paged queue rows carry "by <team member>" from actor_id (redemptionQueue.ts). p_actor filter not built.
5. orgs.owner_active read with the session (admin.ts:206-220, :265); notices in AgencyClient (seat console, managed creator, managing tie). App never inserts agency_owner_suspended.
6. Manual org_member_creators delete removed (admin.ts:426-430).
7. delete_wheel(p_wheel, p_only_if_empty) for "Remove it" (wheels.ts:840; route ?hard=1&empty=1; handler not_empty -> 409).
8. gameChangeRefusal covers ok/not_found/forbidden/game_not_ready (+ others) (emptyGame.ts).
9. Brand refusal untouched (fan builder's version expected); e2e assertion for brand_too_dark removed.

Gate: see gate7.txt, j-all.log, a11y-*.log.

## Round 4 (suspended-account audit S1-S7, agency banner, display name)

Commits: 72e49da (merge 3169542), 4c1cca5, 7a0bd95, 7037067, e9a439e (merge 66473cd).

- S1: close/route.ts reads the agency impact first (:88), writes notices + org.dissolve only after ok/pending (:92); suspended refused up front (:61-63) unless its own close is under way. Same order in admin/account/delete/route.ts (:96, :106) and adminAgencyAction. Notice ids derived (agencyAdmin.ts:55) so a retry tells each person once.
- S3/S5: admin.ts:681, :710 own is_active on the session before insert / service role / alert mail.
- S4: gameUnlock.ts:117 (can_act_for literal true), :105 maps 23505 to "already".
- S6: terms.ts:72 own is_active before record_terms_acceptance; a suspended account is not prompted.
- Silent own-row setters: sessionMayManageSelf before set_public_profile / set_creator_note (publicProfile.ts:284), set_chat_settings (inbox.ts:561), set_leaderboard_enabled (boosts.ts:395), set_pwa_icon_mode (pwa.ts:116); ownAccountActive before set_display_name (account.ts:206).
- /agency: SuspendedBanner + "Agency console paused" for a suspended viewer; journeys (WU-01 extended, WG-13 new) and two a11y states.

Gate: gate8.txt, j-all.log, a11y-*.log.

## Round 5 (0073 review follow-ups)

Commits: 6c36897 (merge b879c22), c-rewards, c-queue-actor, 3bda214, 0b77a52 (e2e locator), abc5feb (merge a28f128), aed610e (org_briefs read).

- 23505 on the unlock index → "already", no mail (gameUnlock.ts:105; done in 7a0bd95).
- creator_unavailable → forbidden in setPrizeDelivery / addPrizeCodes (rewards.ts).
- p_actor: listRedemptionQueue({ actorId }) → route ?actor= → PrizesPanel "Only theirs" / "Show everyone's".
- delete_wheel not_empty read at wheels.ts:842; orgs.owner_active read for seats (readOrgState), org_briefs first for a managed creator (readManagedOrgState).
- createOrg: name_reserved (pre-check + 22023 /reserved/), forbidden (42501), invalid_name.
