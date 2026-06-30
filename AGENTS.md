<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Supabase auth contract (non-negotiable)

Agent-generated auth often "works in dev" while being insecure. These rules are
binding for any change that touches auth, roles, RLS, or the service key:

1. **Never authorize from `user_metadata`.** It is user-editable. Authorization
   reads come from a server-side source only.
2. **Roles/permissions are server-controlled** — the `profiles` table, read via
   the SECURITY DEFINER `is_admin()` / `can_act_for()` functions (which also
   require `is_active`). Never `app_metadata`/`user_metadata` for role decisions.
3. **The service-role key is server-only.** It lives in `SUPABASE_SERVICE_ROLE_KEY`
   (never a `NEXT_PUBLIC_*` var) and is reachable only through
   `createServiceClient()` in `src/lib/supabase/server.ts`. It must never appear
   in a `"use client"` module, the browser bundle, logs, or client env.
4. **Client code uses the anon key + RLS** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`).
5. **Privileged operations go through server routes** with an explicit
   `is_admin()` / `can_act_for()` check — never a client calling a privileged RPC
   directly. Server-only RPCs are `revoke`d from `anon`/`authenticated`.
6. **Every table has RLS enabled with a policy** before the feature is "done."
   No `using (true)` / `with check (true)`. A creator can never UPDATE their own
   `profiles` row (role/features escalation) — that policy is admin-only.
7. **A negative test must exist** proving a normal user cannot self-promote or
   reach admin paths.

## Acceptance check — run before claiming an auth-touching task is done
Answer all four with file:line evidence; if you can't, the task is NOT done:
- **Where does authorization happen?** (the route/RPC + the `is_admin`/`can_act_for` call)
- **Prove the role source is server-controlled** (not `user_metadata`/`app_metadata`).
- **Prove the service key can't reach the client** (no `"use client"` import of
  `supabase/server`; key is not `NEXT_PUBLIC`).
- **Show the negative test** and that it passes:
  - `npm test` → `rls.test.ts` (static: RLS on every table, no wide-open policies)
  - `node scripts/security/rls-runtime-test.mjs` (runtime: cross-tenant isolation
    + a normal user cannot promote itself to admin) against a configured project.

# Deploy / release workflow (test on preview before prod — non-negotiable)

`main` IS production. Merging to `main` auto-deploys the live Vercel site (and,
once the migration workflow is on `main`, auto-applies DB migrations). Nothing
reaches prod except by an explicit merge to `main`.

**Environments:** Production (Vercel) → **prod** Supabase. Preview (every branch)
→ **test** Supabase. So a branch preview can be exercised hard without touching
real data.

**Pipeline for every change:**
1. Work on a branch off `main`. Never commit or push straight to `main`.
2. Push → Vercel builds a Preview backed by the **test** project. Verify the
   change FULLY on that Preview URL (real clicks), not just CI.
3. Only after it's verified on Preview **and** CI is green
   (`verify` / `supabase` / `login-ui`) → merge to `main` → prod deploys.

**Rules the agent MUST follow:**
- **Never merge to `main`** without (a) all CI checks green AND (b) explicit user
  confirmation the change was tested on its Preview. CI passing is necessary but
  NOT sufficient — "tested on preview before prod" is mandatory.
- **`dashboard-redesign` (and any large/experimental work) stays OFF `main`**
  until the user explicitly says it is fully verified and approved. Never merge
  it on your own initiative — it must live on its branch / preview until then.
- **DB before code:** a migration must reach the target database BEFORE the code
  that needs it goes live — apply to **test** before previewing, to **prod**
  before (or exactly at) the merge to `main`.
