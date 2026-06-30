# Supabase Auth Contract (portable)

Drop this into any Supabase + agent-assisted repo. Agent-generated auth often
"works in dev" while being insecure (the bad version passes a happy-path click
test). This contract makes the security rules explicit and adds an acceptance
check the agent must satisfy *before* calling an auth-touching task done.

> How to use: paste the **Rules** + **Acceptance check** into your project
> instructions (`AGENTS.md` / `CLAUDE.md` / `.cursorrules`). Fill the
> `<angle-bracket>` blanks with your project's real function/table/file names.

---

## Rules (non-negotiable)

1. **Never authorize from `user_metadata`.** It is user-editable (a signed-in
   user can set it). Authorization reads come from a server-side source only.
2. **Roles/permissions are server-controlled.** Source of truth is a server-side
   table (e.g. `profiles.role`) read through a `SECURITY DEFINER` function
   (e.g. `<is_admin()>`), or a verified server-side claim — **not**
   `user_metadata`, and not `app_metadata` unless it is set exclusively by a
   trusted server process and treated as read-only by clients.
3. **The service-role key is server-only.** It lives in a non-public env var
   (`SUPABASE_SERVICE_ROLE_KEY`, never `NEXT_PUBLIC_*` / `VITE_*` / `EXPO_PUBLIC_*`).
   It is reachable through exactly one server module (e.g. `<lib/supabase/server>`),
   and must never appear in a client component, the browser bundle, logs, error
   messages, or client-readable env.
4. **Client code uses the anon key + RLS.** Every client query is authorized by
   Row Level Security, not by trusting client-side checks.
5. **Privileged operations go through server routes/functions** with an explicit
   authorization check. A client must never call a privileged RPC directly —
   server-only RPCs are `revoke execute ... from anon, authenticated` and granted
   only to `service_role`.
6. **Every table has RLS enabled with a policy** before the feature is "done."
   No `using (true)` / `with check (true)`. In particular, a normal user must not
   be able to UPDATE their own role/permission columns (make that policy
   admin-only, or block the column with a trigger).
7. **A negative test exists** proving a normal user cannot self-promote or reach
   admin-only data/paths.

## Acceptance check (run before claiming the task is done)

Answer all four with `file:line` evidence. If any cannot be shown, the task is
**not** done:

1. **Where does authorization happen?** Point to the route/RPC and the explicit
   role/permission check.
2. **Prove the role source is server-controlled** — show it reads the server-side
   table / verified claim, and grep proves nothing authorizes from
   `user_metadata`.
3. **Prove the service key cannot reach the client** — no client/`"use client"`
   module imports the server Supabase module; the key is not a public env var;
   it does not appear in any bundle or log.
4. **Show the negative test and that it passes** — a normal authenticated user
   cannot set their own role to admin and cannot read/write admin-only rows.

## Copy-paste audit commands

```bash
# (1/2) Nothing authorizes from user_metadata (writes of display fields are OK;
#       reads used for an auth decision are NOT). Inspect each hit.
grep -rnE 'user_metadata|raw_user_meta_data|app_metadata' src/ | grep -vi test

# (3) Service key is never a public env var (must be empty)
grep -rnE 'NEXT_PUBLIC_[A-Z_]*(SERVICE|SECRET|ROLE_KEY)|(VITE|EXPO_PUBLIC)_[A-Z_]*SERVICE' .

# (3) No client module imports the server Supabase/service client (must be empty)
for f in $(grep -rlE 'createServiceClient|lib/supabase/server' src/); do \
  head -1 "$f" | grep -q '"use client"' && echo "LEAK: $f"; done

# (6) Every table has RLS enabled + a policy; no wide-open policies
grep -rnE 'using \(true\)|with check \(true\)' supabase/   # must be empty
grep -rnE 'enable row level security' supabase/            # one per table
```

## Negative test (sketch — adapt to your stack)

Sign in as an ordinary user with the **anon** key and assert escalation fails:

```js
// signed in as a normal creator `A` using the ANON key
const promote = await a.from("profiles")
  .update({ role: "admin" }).eq("id", A.id).select("id");
assert(promote.data?.length === 0);                 // RLS no-op, not an error leak

// re-read with the service role: the role must be unchanged
const { data } = await admin.from("profiles").select("role").eq("id", A.id).single();
assert(data.role !== "admin");

// and a normal user reads zero admin-only / other-tenant rows
const others = await a.from("profiles").select("id").neq("id", A.id);
assert(others.data?.length === 0);
```

---

### Common failure modes this catches
- Role read from `session.user.user_metadata.role` (client-editable → instant admin).
- `SUPABASE_SERVICE_ROLE_KEY` exposed via a `NEXT_PUBLIC_*` var or imported into a
  client component → full DB access leaks to the browser.
- A table shipped with RLS disabled, or a `using (true)` policy → every row public.
- `profiles`/`users` UPDATE policy that lets a user write their own `role` column.
- A privileged RPC left `EXECUTE` to `authenticated` → callable straight from the
  browser, bypassing server checks.
