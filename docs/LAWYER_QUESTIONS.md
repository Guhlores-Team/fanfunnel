> What this is: the open legal questions from the batch-6 trust & safety audit, copied verbatim for the owner to take to a lawyer (OWNER_STEPS 22).

# Questions for the lawyer (trust & safety audit, commit 987125e)

1. **Prize, chance and payment.** Now: fans tip the creator off-platform, then get spins. Out-of-spins button:
   "Tip {creator} to unlock more spins" (src/components/fan/TopUpMoment.tsx:69). Creator field: "Tip / buy-spins link
   (where fans go to pay)" (SettingsPanel.tsx:907, BoostsPanel.tsx:327). Priced spin packs exist (campaign_packs.amount_cents).
   Q: does this make each wheel a lottery/sweepstakes? Who is the sponsor? Do we need a free entry route (AMOE) and official rules?
2. **"No gambling" claim.** Now: landing page says "No gambling, no fees … every spin yields a guaranteed reward"
   (src/app/page.tsx:66); near-miss animations (NearMissBeat.tsx), pity guarantee (engine.ts:71), happy hours, Focus/Chase.
   Q: can we say "no gambling"? Which features raise risk under gambling, loot-box or consumer law (FTC dark patterns, EU UCPD)?
3. **Odds disclosure.** Now: prize book shows chance next to "Not yet…" (PrizeBook.tsx:84-88); /c/[slug] shows prizes without
   odds; exact odds on each verify page afterwards. Q: enough? Must odds be shown by prize name, before entry, publicly?
4. **Fan access request scope.** Now: export omits creator-sent messages (privacy.ts:184), grants.amount_cents, creator
   notes/tags, delivery notes (exportTypes.ts:114-118). Q: must a subject-access copy include these? Who answers it?
5. **Controller or processor.** Now: Privacy says FanFunnel controller + creator "also responsible" (privacy/page.tsx:62-66);
   LEGAL_NOTES:126 says creator is controller; built behaviour is controller-like (privacy.ts:264; retention; admins read/write
   chats schema.sql:1457); no data addendum for creators (terms:306-309). Q: which role, and what creator terms?
6. **Special-category data.** Now: which adult creator a person follows, chats, spend, notes, tags stored; no Art. 9 basis
   claimed. Q: sex-life data → explicit consent, DPIA, EU/UK representative?
7. **Age gate strength.** Now: self-confirmation checkbox, time + version stored (FanGameController.tsx:891, fans.ts:717);
   enforced server-side only for spinning (inbox.ts:132-190 not); /c has no gate; consent proves only "someone holding this
   link" agreed (LEGAL_NOTES:138-146). Q: enough for adult creators' audiences (Texas HB 1181, UK OSA) given no explicit images?
8. **Retention.** Now: messages, fans, spins kept indefinitely while the creator exists (DATA_RETENTION.md); rejected
   applications kept, no self-delete (privacy:479, PendingClient.tsx:73). Q: required/defensible periods?
9. **Fans added by import.** Now: bulk-imported names get no notice until they open a link (Art. 14). Q: who gives notice, how?
10. **Unfulfilled prizes when a creator leaves.** Now: self-close possible with pending prizes; fan sees "Thanks for playing",
    records deleted (close/route.ts:36-62, LinkGone.tsx:11); Terms say creator "stays responsible" (terms:433) and disclaim
    FanFunnel (terms:463-466). Q: exposure (consumer law, Mass. G.L. c.93A)? Keep/show records or block closure?
11. **Notice of Terms changes and evidence.** Now: 30 days' notice "marked as upcoming" promised (terms:526, privacy:601), no
    mechanism; one version held (legal.ts:23); text changed after 2026-10-27 without a bump; record stores account, version,
    time only. Q: enforceable clickwrap requirements; publish past versions?
12. **Agency chatters.** Now: "chatter" seats reply as the creator (can_act_for 'chat', inbox.ts:405-420); fans not told.
    Q: disclosure required (FTC Act, state laws)?
13. **Child-safety reporting duty.** Now: "Involves someone under 18" report → admin e-mail with no content; no procedure,
    no NCMEC registration, no law-enforcement contact; Privacy mentions reporting CSAM (privacy:323-325).
    Q: 18 U.S.C. §2258A duties? Procedure and preservation period?
14. **Safety reports kept after deletion.** Now: report about a creator survives deletion with a name snapshot (owner decision 1);
    fan's free text kept after the fan deletes (privacy.ts:296). Q: lawful basis and period?
15. **Prize tax and value limits.** Now: prizes can be anything incl. cash equivalents/codes. Q: ban or cap cash-equivalents?
    1099 duties purely the creator's?
16. **Adult text on public pages.** Now: SFW rule covers photos only (terms:296-299); prize names, taglines, creator notes,
    board names public and ungated (/c/[slug], /leaderboard). Q: age-verification / harmful-to-minors scope? "No 2257 content" enough?
