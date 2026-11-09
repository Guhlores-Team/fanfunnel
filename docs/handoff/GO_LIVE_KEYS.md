# Go-live keys: Vercel settings checklist (owner, step by step)

Checked against the real Vercel project on 2026-11-04 (names only; no values were read).
Do these **only when we are ready to go live**, after you have said "go" and tested the Preview.

Where you add every key: **[Vercel → fanfunnel → Settings → Environment Variables](https://vercel.com/easy-simple-sites/fanfunnel/settings/environment-variables)**

For each key: click **Add New** → type the **Name** exactly as written → paste the **Value** →
tick only the **Environment** listed (usually just **Production**) → if it says *Sensitive*, switch
**Sensitive** on → **Save**.

Golden rules:
- **Never paste a key into a chat, e-mail or document** (including with me). Paste it only into Vercel
  and into your password manager.
- **Production keys are brand-new.** Never copy a Preview value into Production.
- The two **reward keys must be backed up** before you save them. If they are lost, every unclaimed
  reward code becomes unreadable forever.

---

## Already done (no action)

| Key | Production | Preview |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | ✅ set | ✅ set (TEST) |
| Upstash rate-limit store (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL`, `KV_REST_API_READ_ONLY_TOKEN`) | ✅ set | ⚠️ set, but the **same** store as Production (step 7) |
| `NEXT_PUBLIC_ENABLE_DEBUG` | ✅ correctly **absent** | ✅ `1` |
| `REWARD_ENCRYPTION_KEY`, `REWARD_CODE_FINGERPRINT_KEY` | ❌ **missing** (step 3) | ✅ set |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | ❌ **missing** (step 5) | ✅ set |
| `ADMIN_EMAILS`, `FF_REQUIRE_SUPABASE` | ❌ **missing** (step 2) | ✅ set |
| `CRON_SECRET` | ❌ **missing** (step 4) | — not needed |
| `RESEND_API_KEY`, `ALERT_EMAIL_TO` | ❌ **missing** (step 6, **required**: creator e-mail) | ❌ missing (recommended for testing creator e-mail) |

---

## Step 1: Get ready (2 minutes)

1. Open your password manager and create a new secure note called **"FanFunnel LIVE keys"**.
   You will paste each new key there first, then into Vercel.
2. Open the Terminal app:
   - **Mac:** press ⌘ + Space, type `Terminal`, press Enter.
   - **Windows:** press Start, type `PowerShell`, press Enter.

## Step 2: Two simple settings (Production)

| Name | Value | Sensitive |
|---|---|---|
| `ADMIN_EMAILS` | your admin e-mail address (the one you log in with) | no |
| `FF_REQUIRE_SUPABASE` | `1` | no |

## Step 3: The two reward keys (Production, Sensitive, BACK UP FIRST)

Do this twice, once for each key, and save each result in your password note **before** Vercel.

- **Mac Terminal:** paste this and press Enter:
  ```
  openssl rand -base64 32
  ```
- **Windows PowerShell:** paste this and press Enter:
  ```
  $b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
  ```

It prints one line ending in `=`, for example `k3J...Q=` (about 44 characters).

| Name | Value | Sensitive |
|---|---|---|
| `REWARD_ENCRYPTION_KEY` | the **first** line you generated | **yes** |
| `REWARD_CODE_FINGERPRINT_KEY` | the **second**, different line | **yes** |

Never change or "rotate" these later to make an error go away. If they ever must change, there is a
safe procedure in `docs/GO_LIVE.md` §4; ask me first.

## Step 4: The maintenance secret (Production, Sensitive)

- **Mac Terminal:**
  ```
  openssl rand -hex 32
  ```
- **Windows PowerShell:**
  ```
  $b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b|%{$_.ToString('x2')})
  ```

It prints 64 letters/numbers.

| Name | Value | Sensitive |
|---|---|---|
| `CRON_SECRET` | that line | **yes** |

This lets the nightly clean-up and alert job run. Without it, the job refuses to run.

## Step 5: Phone push notifications (Production)

These need a brand-new pair for the live site. If you have Node installed, run:
```
npx web-push generate-vapid-keys
```
It prints a **Public Key** and a **Private Key**. If you don't have Node, tell me "I need VAPID keys"
at go-live and we will do it together step by step.

| Name | Value | Sensitive |
|---|---|---|
| `VAPID_PUBLIC_KEY` | the Public Key | no |
| `VAPID_PRIVATE_KEY` | the Private Key | **yes** |
| `VAPID_SUBJECT` | `mailto:` followed by your e-mail, e.g. `mailto:you@example.com` | no |

## Step 6: E-mail: creator account mail and alerts (required on Production)

`RESEND_API_KEY` is **required**, not optional: without it no creator gets the
"you're approved" e-mail, agency invitees get no invitation e-mail, and admins
get no "new access request" e-mail (the app then stops promising those e-mails;
the in-app bell still works). Account e-mail goes out as **"FanFunnel
<account@easysimplesites.org>"** (the alert sender's domain; set
`ACCOUNT_EMAIL_FROM` only to use a different verified address). Error alerts and
the new-request note go to `ALERT_EMAIL_TO`. On Preview the key is optional;
add it there to test these e-mails against the TEST project.

1. Go to **[resend.com → API Keys](https://resend.com/api-keys)** → **Create API Key** → name it
   `fanfunnel-live` → permission **Sending access** → domain **easysimplesites.org** → create →
   copy it once.
2. Add in Vercel:

| Name | Value | Sensitive |
|---|---|---|
| `RESEND_API_KEY` | the key from Resend | **yes** |
| `ALERT_EMAIL_TO` | the e-mail address that should receive alerts and new-request notes | no |
| `ACCOUNT_EMAIL_FROM` | optional; only to send account mail from another verified address | no |

## Step 7: Separate the Preview rate-limit store (Preview + Production)

Today Preview and Production share one Upstash database, so any branch build can change
Production's spin limits.

1. Open **[Vercel → Storage](https://vercel.com/easy-simple-sites/~/stores)** → **Create Database** →
   **Upstash for Redis** → name it `fanfunnel-preview` → connect it to project **fanfunnel**, environment
   **Preview** only (untick Production and Development).
2. Open **[Environment Variables](https://vercel.com/easy-simple-sites/fanfunnel/settings/environment-variables)**.
   For each of the five old store variables (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL`,
   `KV_REST_API_READ_ONLY_TOKEN`) that still lists **Preview**: **Edit** → untick **Preview** → **Save**, so
   the old store is **Production** only and the new one is **Preview** only.

## Step 8: Build settings (one time)

1. **[Build and Deployment](https://vercel.com/easy-simple-sites/fanfunnel/settings/build-and-deployment)** →
   **Node.js Version** → **22.x** → **Save**. (Leave **Install Command** alone: the repository's `vercel.json`
   already sets `npm ci`.)
2. **[Git](https://vercel.com/easy-simple-sites/fanfunnel/settings/git)** → check **Git Fork Protection** is **on**.

## Step 9: GitHub secrets into environments (one time, ~10 minutes)

Full list and order: [`docs/GO_LIVE.md` section 2, "Supply-chain settings"](../GO_LIVE.md#supply-chain-settings-batch-6-audit).
In short, at **[GitHub → Environments](https://github.com/Guhlores-Team/fanfunnel/settings/environments)**:

1. **`test`** → **Add environment secret** `SUPABASE_TEST_DB_URL`: the TEST **Session pooler** string from
   **[Supabase TEST → Connect](https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu?showConnect=true)**
   (port 5432) with the TEST database password filled in. Also add `SUPABASE_TEST_PROJECT_REF`,
   `SUPABASE_TEST_DB_PASSWORD`, `VERCEL_TOKEN`, `FANFUNNEL_TEST_CRON_SECRET` here.
2. **`production`** → Required reviewers = you; Deployment branches = **Selected** → `main`; add
   `SUPABASE_PROD_PROJECT_REF`, `SUPABASE_PROD_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`.
3. Then, at **[Actions secrets](https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions)**, delete the
   repository copies of `SUPABASE_PROD_DB_PASSWORD`, `SUPABASE_PROD_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`
   and `VERCEL_TOKEN`. Keep the three TEST app secrets there.
4. **[Supabase access tokens](https://supabase.com/dashboard/account/tokens)**: revoke the old CI token and
   use a fresh one for step 2.

## Step 10: Tell me you're done

Just say **"keys are in"**. Don't send any values. I will then:
1. Redeploy Production so it picks up the new keys.
2. Check **Admin › System health** is green: reward keys found, schema version current, rate-limit
   store shared, maintenance job configured.
3. Send a safe test alert so you can confirm it arrived in your inbox.

---

## Related go-live settings (not keys, also one-time)

- **GitHub secrets** (OWNER_STEPS 14a): add the TEST trio as Dependabot secrets so automated update
  checks run the database tests instead of failing.
- **Vercel Deployment Check** (OWNER_STEPS 14b, `docs/GO_LIVE.md` §5): makes Vercel hold a Production
  release until the database migrations have been confirmed. I'll walk you through it at go-live.
- **Vercel Toolbar on Previews:** the new security policy blocks it. Turn it off in Vercel
  (Settings → General → Vercel Toolbar) or ignore the "CSP blocked … vercel.live" lines in Admin › Errors.
