-- 0030 Close the org_add_creator consent-bypass (multi-review Audit 2 #2 — HIGH).
--
-- The app onboards org creators via the consent-based INVITE flow
-- (inviteOrgCreator -> org_invite_creator; the creator must accept) — see
-- src/app/api/agency/manage/route.ts (`case "add_creator"` calls inviteOrgCreator).
-- The legacy public.org_add_creator() force-sets profiles.org_id after ONLY an
-- _owns_org() check, so an org owner could call it directly via PostgREST to add
-- any creator to their org WITHOUT consent (gaining can_act_for over them). It is
-- not invoked anywhere in the app, so revoke client execute (leave it callable
-- only by service_role). Revoke (not DROP) avoids any dependency-failure risk.

revoke execute on function public.org_add_creator(uuid, text) from public, anon, authenticated;
grant  execute on function public.org_add_creator(uuid, text) to service_role;
