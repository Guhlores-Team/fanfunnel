# Legal notes for the owner (not shown on the site)

This is a list of legal risk areas to take to a lawyer **before FanFunnel is marketed**.
It was written by reading the code, not by a lawyer, and it is not legal advice. It names
the concerns and the usual ways businesses deal with them, but it does not settle any of them.

The public Terms (`src/app/terms/page.tsx`) and Privacy Policy (`src/app/privacy/page.tsx`)
are plain-English drafts grounded in how the product works today. The operator name, contact
email, governing law, venue, minimum age and effective date all live in `src/lib/legal.ts`.
Have a lawyer review both documents along with this list.

---

## 1. Prize wheels and lottery / sweepstakes law (highest priority)

**The concern.** In most US states (and many other countries) a promotion is an illegal
lottery when it has all three of: **a prize**, **chance**, and **consideration** (paying
or giving something of value to take part). Remove any one and it is usually lawful.
FanFunnel's core loop appears to have all three:

| Element | Where it shows up in the product |
|---|---|
| Prize | Every spin lands on a creator-supplied prize, tiered common → legendary (`prizes` table, `supabase/schema.sql:78`). |
| Chance | Weighted random draw on the server (`src/lib/games/wheel/engine.ts`, `fairnessV3.ts`). "Every spin wins" does not remove chance: prizes differ in value, and the rare ones are the draw. |
| Consideration | Fans get spins after tipping. `PRODUCT.md:9`: "They tip the creator, get spins". The out-of-spins prompt says **"Tip {creator} to unlock more spins"** (`src/components/fan/TopUpMoment.tsx:69`) and teases the best prize the fan hasn't won yet (same file, line 12). The settings field is labelled **"Tip / buy-spins link (where fans go to pay)"** (`SettingsPanel.tsx:862`, `BoostsPanel.tsx:327`). Creators define priced **spin packs** (`campaign_packs.amount_cents`, `schema.sql:418`) and record an amount against each grant (`grants.amount_cents`, `schema.sql:367`). |

The money never flows through FanFunnel, and the Terms say so and make creators responsible
for their promotions. That helps, but it may not be enough: a platform that is built
to run paid chance-based draws, and that calls the payment link "buy-spins", could be seen
as promoting or facilitating them. Questions for the lawyer:

- Is each creator the "sponsor" or "operator", is FanFunnel, or are both?
- Which laws apply: Massachusetts (G.L. c. 271 covers lotteries and gaming), the fan's state,
  the creator's country, and the UK Gambling Act 2005 and EU national gambling laws for overseas fans?
- Are spins, as designed, closer to "loot boxes" (which some countries regulate or ban, such as
  Belgium) than to a sweepstakes?

**Usual mitigations (for discussion, not decided):**

- **Free alternative method of entry (AMOE).** Give any fan an equal way to get spins for free
  (for example a free request form, or a fixed number of free spins per period) with the
  **same odds** and equal prominence, and say so in official rules. This is the standard
  "no purchase necessary" structure. It only works if it is real and not buried.
- **Decouple payment from spins.** Stop saying "buy spins" and "tip to unlock more spins". Make
  spins a free thank-you that is not promised in exchange for a set payment, and remove or
  rework priced spin packs. Changing the copy alone is weak if the mechanics stay the same.
- **Make it a game of skill.** Where skill (not chance) decides the result, most lottery laws
  stop applying. A spinning wheel is hard to turn into a real skill contest.
- **Official rules per promotion**: sponsor, eligibility, how to enter free, odds, prize
  values, dates, and how winners are notified. Some states require **registration and bonding**
  for sweepstakes above a total prize value (New York and Florida, above US$5,000).
- **Cap or restrict prizes.** Consider banning cash and cash-equivalent prizes (gift cards,
  crypto). The Terms already say spins have no cash value and FanFunnel never pays out.
- **Geo-restrict** places where the structure cannot be made lawful.
- **Disclose odds before the spin.** Today the odds a spin used are shown only afterwards,
  on its verify page. The spin page itself shows prizes and rarity, not percentages.

**Features that make it look more like gambling**, which regulators and consumer-protection
bodies (FTC "dark patterns", EU Unfair Commercial Practices Directive) tend to examine:

- "So close!" near-miss animation after a spin (`src/components/NearMissBeat.tsx:97`).
- Pity guarantee: a rare prize is forced after 10 spins without one (`engine.ts:71`).
- Happy hours that boost rare odds for a set time (`happy_hours`, `applyRareBoost`).
- Out-of-spins upsell that shows the best prize not yet won (`TopUpMoment.tsx`).
- Referral bonus spins for bringing in new fans (`referrals`, `schema.sql:536`).
- The code comments describe self-exclusion as "NOT a spend limit, we don't gamble"
  (`schema.sql`, near line 1108). A regulator would look at what the product does, not at
  what it is called.

Also: `orgs.billing_model` allows `'rev_share'` (`schema.sql:1254`). If FanFunnel ever takes a
share of creators' tip revenue, it is sharing in the proceeds of the draw. Review that before
building any billing.

## 2. Adult-content considerations

`PRODUCT.md` describes fans as "an adult-content creator's audience", and the access form
suggests OnlyFans / Fansly / Fanvue (`PendingClient.tsx:132`).

- **18 U.S.C. § 2257 (record-keeping).** This applies to producers of sexually explicit
  visual depictions, and in some cases to those who host them. FanFunnel stores and publicly
  serves creator **avatars** (public `avatars` bucket, `supabase/migrations/0019_avatars_storage.sql`,
  upload at `src/app/api/account/avatar/route.ts`) and **prize images** (public `prize-photos`
  bucket, `schema.sql:577`, plus image URLs accepted by `/api/wheel`). Nothing stops an
  explicit image being uploaded today. Options: an explicit **SFW-only rule** for uploads
  (the public page is already described as a "SFW link-in-bio") with moderation, or 2257
  compliance if explicit media is ever allowed.
- **State age-verification laws.** Texas (HB 1181, upheld by the US Supreme Court in *Free
  Speech Coalition v. Paxton*, 2025), Louisiana, Utah, Virginia and a growing list of other
  states require real age verification on sites where a large share of content is "harmful to
  minors". FanFunnel's age gate is a **self-confirmation checkbox** (`SpinClient.tsx`, `AgeGate`).
  It records the time and the Terms version agreed to (`fans.acked_at`, `fans.acked_terms_version`,
  migration 0055), but nothing that proves age. Ask whether FanFunnel
  is in scope. The answer probably depends on keeping FanFunnel itself free of explicit
  content. The UK Online Safety Act has similar "highly effective age assurance" duties for
  pornographic content.
- **Creators' age and consent.** Creators are vetted by hand (`creator_applications`), but
  there is no check of a creator's age or ID, and no check that people shown in uploaded
  images consented. Note: the Terms already ban content involving minors and non-consensual content.
- **Payment processors and app stores.** Card networks (Visa and Mastercard adult-content
  standards) and app stores have adult-content rules. This matters most if FanFunnel ever
  charges creators, and if processors treat a paid prize wheel as gambling.
- **Chat staffed by agency "chatters".** Agencies can give staff a `chatter` role that can
  message fans as the creator (`org_role`, `schema.sql:1247`, `can_act_for` at `schema.sql:1328`).
  If fans believe they are talking to the creator personally, that may raise deception concerns
  (FTC Act, state consumer laws) and may break some creator platforms' rules. Consider a disclosure.

## 3. GDPR / UK GDPR

- **Special-category data.** A record that a person is a fan of an adult creator, along with
  notes, tags, chat and spend amounts, can reveal information about their **sex life or sexual
  orientation** (GDPR Art. 9). If so, a stricter legal basis is needed (usually explicit
  consent), and a **Data Protection Impact Assessment** is likely required. The Privacy Policy
  does not currently claim an Art. 9 basis. The lawyer should decide this first, because the
  next two items depend on it.
- **EU and UK representative (Art. 27).** A non-EU business that offers services to people in
  the EU must appoint an EU representative, unless its processing is occasional, low-risk and
  does not involve large-scale special-category data. That exemption may not be available
  here (see above). The UK has the same rule. Representatives are a paid service (often a few
  hundred dollars a year).
- **Data Protection Officer (Art. 37).** This is required if FanFunnel's core activities
  involve large-scale processing of special-category data. It probably does not apply at launch
  scale, but record the reasoning.
- **Processor agreements (Art. 28).** Sign or accept the standard DPAs with **Supabase, Vercel,
  Upstash and Resend**, and make sure each covers international transfers (Standard Contractual
  Clauses or Data Privacy Framework certification).
- **FanFunnel as a processor for creators.** Creators enter fan data (names, notes, tags, spend),
  so the creator is a controller of it. FanFunnel likely needs **creator-facing data-processing
  terms** (a DPA in the creator agreement). The Privacy Policy describes this shared role in
  plain words, and a lawyer should confirm it.
- **Paperwork to keep:** a record of processing activities (Art. 30), a breach-response plan
  (72-hour notification), a retention schedule, and a procedure for verifying data requests
  from fans, who have no account.
- **Transfers.** The Privacy Policy says the database is hosted in the United States. Neither the
  Supabase project region nor the Upstash region is recorded in the code or config, so confirm
  both (Supabase: Project Settings → General; Upstash: the database's details page) and correct
  the policy if either is outside the US. Confirm them again when signing each DPA.

**US state privacy laws.** The CCPA/CPRA applies only above thresholds (roughly US$26M revenue,
100,000 consumers, or 50% of revenue from selling or sharing data), so it probably does not
apply yet. The policy offers the rights anyway, which is harmless. Several states (for example
Virginia, Colorado and Connecticut) treat sex-life data as "sensitive" and require opt-in consent
once their thresholds are met.

## 4. Other exposure found in the code

1. **No registered DMCA agent.** The Terms explain how to send a takedown notice, but the
   US § 512 safe harbour also requires **designating an agent with the US Copyright Office**
   (an online form with a small fee, renewed every 3 years).
2. **No legal entity yet.** The documents name the brand "FanFunnel". Operating without an
   entity may leave the owner personally liable. When an entity exists, change
   `LEGAL.operator` in `src/lib/legal.ts`. Consider insurance (general liability, cyber and
   media).
3. **Dispute terms.** The Terms choose Massachusetts law and Massachusetts courts and contain
   **no arbitration clause or class-action waiver**. Whether to add them is a lawyer's call.
   Massachusetts consumer law (G.L. c. 93A) may limit how far disclaimers and liability caps
   apply to consumers. EU and UK consumers keep their home-country protections regardless.
4. **Spend data about fans.** Creators record what each fan paid (`grants.amount_cents`), and
   the CRM shows "total and average spend" (`CrmPanel.tsx:64`). Combined with an adult context,
   this is sensitive and makes a breach more harmful.
5. **Admin access to chats.** FanFunnel admins can read every creator–fan chat (RLS
   `messages_rw` allows `is_admin()`). The policy says so. Have an internal rule for when
   staff may look.
6. **Prize tax.** In the US, prize winners may owe tax, and sponsors may have to file
   information returns for high-value prizes (Form 1099-MISC). The Terms put prize obligations
   on creators. Confirm that is enough.
7. **Self-service data tools.** Deletion and access requests are handled by email today
   (`HowToRequest` in `src/app/privacy/page.tsx`). When the planned "Delete my data" /
   "Download my data" controls ship, update that block, the summary line and the termination
   section of the Terms.
8. **Creator fees later.** FanFunnel is free for creators today; the Terms promise
   `LEGAL.changeNoticeDays` (30) days' notice before any fee and that fans are never charged.
   If billing is introduced, it needs its own terms (and see `rev_share` in section 1).
9. **Notice period.** The Terms and Privacy Policy promise 30 days' notice of material changes
   (email to creators, an in-app or on-page notice for fans), with an exception for changes
   required by law or needed for security. Bumping `LEGAL.version` asks every creator and fan to
   agree again; the email to creators is a manual step today. The code holds one version at a
   time, so the process for a material change is: (1) email creators the new text and its start
   date at least 30 days ahead, and post a notice on the pages; (2) on the start date, publish the
   new text and set `LEGAL.effectiveDate` and `LEGAL.version` to that date in the same deploy.
   Ask the lawyer whether that is enough, and whether fans (who have no email on file) need more
   than the re-shown gate.
10. **Fans who agreed before 0055.** Fans who ticked the gate before this change have a time but no
   version on record, so they see the gate once more and agree to the current version. That is
   deliberate (they agreed to the earlier placeholder text), and it costs each such fan one tick.
11. **Sign-up with email confirmation.** When Supabase asks a new creator to confirm their email,
   there is no session at sign-up, so the sign-up tick is not stored. The same creator must tick
   the box again on the access request (`/pending`), and that one is recorded; an account approved
   without a request gets the dashboard prompt, which blocks the dashboard until they agree (it is
   a prompt in the page; the dashboard's API routes are not gated on it). The record shows the
   access-request time, not the sign-up time.
12. **Clickwrap evidence.** The record holds the account, the version and the time, not the IP
   address or the exact page wording. Ask whether that is enough to prove assent, and keep old
   versions of both documents (git history does that today) so a given version can be produced.

## Done in the code (kept here for the record)

- Creator clickwrap at sign-up, on the access request and as a one-time dashboard prompt when the
  recorded version is older than `LEGAL.version`. Recorded server-side in
  `profiles.terms_accepted_at` / `terms_version` (migration 0055, `record_terms_acceptance`,
  service-role only).
- Fans' acceptance now stores the Terms version (`fans.acked_terms_version`); a new version shows
  the age/terms gate again.
- The access form no longer mentions payouts.
- The access form says creator accounts are free for now, and its "not approved" screen gives the
  contact address (from `LEGAL.contactEmail`).
- The contact address appears only in `src/lib/legal.ts`; `src/lib/legal.test.ts` fails if any
  other file in `src/` or `e2e/` spells it out. Moving to a FanFunnel domain is a one-line change.
- Error reports: the Privacy Policy's redaction list and "90 days after the problem is resolved"
  match the error-monitoring work on `ops/error-monitoring` (`src/lib/monitoring/scrub.ts`,
  `APP_ERRORS_MAX_ROWS`) and `docs/DATA_RETENTION.md` on `ops/privacy-safety`. Neither branch is
  on `main` yet; re-check the policy if either changes before it merges.
- Resend is the email provider: team alert emails on `ops/error-monitoring` are sent through it,
  and account emails go through Supabase Auth's SMTP settings (configured in the Supabase
  dashboard, not in this repository, so confirm it there).

## Owner answers reflected in the documents

| Question | Answer | Where |
|---|---|---|
| Operator | "FanFunnel" (brand; no entity yet) | `LEGAL.operator`, `src/lib/legal.ts` |
| Governing law and courts | Massachusetts | `LEGAL.governingLaw`, `LEGAL.venue` |
| Contact | `LEGAL.contactEmail` (until a FanFunnel domain exists) | `src/lib/legal.ts`, one line |
| Audience | Worldwide | Privacy Policy: GDPR/UK GDPR, US state rights, transfers |
| Creator fees | Free for now; fees later with notice | Terms "Changes to the Service and fees" and summary |
| Change notice | 30 days | `LEGAL.changeNoticeDays`; both documents' "Changes" sections |
