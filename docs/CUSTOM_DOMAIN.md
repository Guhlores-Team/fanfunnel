# Moving FanFunnel to its own domain

Everything in the app takes its public address from one setting, `NEXT_PUBLIC_SITE_URL`.
The sign-in e-mails take theirs from Supabase's **Site URL**. So a domain switch is settings,
plus one static file the agent updates. Replace `yourdomain.com` below with the real name.

**Do it before real creators and fans arrive.** Sessions, installed home-screen apps and
push notifications belong to one address: anyone who used the old address signs in once more,
re-installs the app and turns notifications back on. Old fan links keep working through a redirect.

## 1. Buy the domain
Easiest: in Vercel, **Domains → Buy** (https://vercel.com/domains). Vercel then manages DNS
itself and steps 2b disappear. Any registrar works too (Cloudflare, Namecheap, Porkbun…).

## 2. Point it at the site
a. Vercel → project **fanfunnel** → **Settings → Domains** → **Add** `yourdomain.com`, then add
   `www.yourdomain.com` and choose "Redirect to yourdomain.com".
b. Bought elsewhere: Vercel shows the exact DNS records to create (an `A` record for the bare
   name, a `CNAME` for `www`). Copy them into your registrar's DNS page **exactly as Vercel shows
   them**, then wait until Vercel shows "Valid Configuration" (minutes, sometimes a few hours).
c. On the same page, open `fanfunnel.vercel.app` → **Edit** → "Redirect to yourdomain.com"
   (permanent). Every link already sent to a fan keeps working: the path is kept.

## 3. Tell the app its address
Vercel → **Settings → Environment Variables** → `NEXT_PUBLIC_SITE_URL` → Production only →
`https://yourdomain.com` (https, no slash at the end) → Save → **Deployments → Redeploy** the
latest Production deployment. A Production build refuses to start without this key.

## 4. Tell Supabase (LIVE project only)
https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/url-configuration
- **Site URL** = `https://yourdomain.com`
- **Redirect URLs**: add `https://yourdomain.com/**`. Keep `https://fanfunnel.vercel.app/**`
  for one week (links already in inboxes), then delete it. Never add an entry with `*` in the host.
The TEST project stays on the Preview address; nothing changes there.

## 5. E-mail
- Today the site sends from `easysimplesites.org` (alerts@ and account@). That keeps working.
- To send from the new domain instead: Resend → **Domains → Add** `yourdomain.com`, create the
  DNS records it lists (SPF, DKIM, and a DMARC record), wait for "Verified", then in Vercel set
  `ALERT_EMAIL_FROM` = `FanFunnel <alerts@yourdomain.com>` and redeploy, and in Supabase LIVE
  **SMTP Settings** change the sender address to `account@yourdomain.com`.
- If the support address changes (today `support@easysimplesites.org`), tell the agent: it is
  printed on the Terms, Privacy, 404 and security pages.

## 6. Tell the agent the domain
The agent then updates `public/.well-known/security.txt` (its Canonical and Policy lines must
name the real address), the docs that quote the old address, and their tests, on a branch.

## 7. Check it (5 minutes)
1. https://yourdomain.com shows the site with the padlock.
2. https://yourdomain.com/api/health answers `ok`.
3. https://fanfunnel.vercel.app/terms lands on https://yourdomain.com/terms.
4. "Forgot password" on the new address: the e-mail's button opens `yourdomain.com`.
5. One fan link sent before the switch still opens the fan page.
