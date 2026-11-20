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

# Added by the batch-7 trust & safety audit (commit 64000ec)

17. **Version discipline.** Terms/Privacy text changed on 2026-11-04 and 2026-11-09 with `LEGAL.version` still "2026-10-27";
    batch 7 bumped both to 2026-11-11 (re-gating every fan and creator once) and added a hash guard. Were the 11-04/11-09
    changes material (pause now permanent; closure held while prizes owed)? If yes, was 30-day notice (terms "Changes to
    these terms") owed, and do the acceptances recorded under 2026-10-27 stand? (TS-01)
18. **Consent evidence.** Is "someone holding the fan's link ticked two boxes at time T, version V" enough age/terms evidence,
    given the creator mints and holds every link and can open it first (TS-05)? What extra signal (device nonce, hashed IP +
    user agent) should be stored, for how long, and may the creator see any of it?
19. **"Free during the pilot".** The access form now says creator accounts are "free during the pilot" and the Terms "free
    for creators today", with 30 days' notice before any fee. Is that wording safe without a fee-change clause? (TS-15)
20. **Impersonation duty.** The Terms now forbid names that present as FanFunnel, its staff or another creator, and the code
    refuses a reserved list. Do you want a takedown path for look-alike slugs and names of OTHER creators (a similarity
    check), and should the rule name other platforms' staff too? (TS-03)
21. **Off-platform contact in public text.** The code now refuses links, e-mail addresses, phone numbers, other-app handles
    and slurs in prize names/descriptions, taglines, creator notes and display names, and only flags them in chat. May we
    block outright, or should some fields (the creator note) be report-only? (TS-04; extends Q16)
22. **Team replies.** Approve the Terms sentence ("may be answered by the creator or by the people they have authorised…")
    and the chat line "replies may come from them or their team". Should team replies carry a visible "Team" label (built,
    off by default)? (TS-07; extends Q12)
23. **Verify page wording.** "A new card began on this paid play" / "tickets" / "draw" on the public verify page: replace, or
    is a factual proof page exempt from the "no consideration" framing? (TS-02c/d; extends Q1)
24. **Push processors.** Google, Apple and Mozilla push endpoints are now listed as processors in the Privacy Policy (they
    receive the push address and an encrypted payload). Correct treatment, and is a transfer mechanism needed for them?
    (TS-09)
25. **Fan's tip amounts.** Is `grants.amount_cents` (the amount a creator notes against spins) the fan's personal data for an
    access request? The fan export omits it and the "blocked" flag today. (TS-13; extends Q4)
26. **Report free text.** Retention period for `reports.detail` (up to 2,000 characters, may contain third-party personal
    data): the Privacy Policy says "kept when the law requires"; is an outer bound needed? (TS-08/26)
27. **Notice mechanism.** The 30-day notice is now a deploy-time notice on fan pages and the dashboard plus a manual e-mail
    to creators; the Terms say exactly that. Enough? Must past versions be published (git history keeps them today)? (TS-06;
    extends Q11)
28. **Creator-attested age gate.** The age gate is the fan's own tick, and the creator attests in the Terms that they only
    deal with adults. With a creator able to clear the gate on a fan's behalf (Q18), is creator attestation plus the tick a
    defensible age-assurance posture for an adult-creator audience, or is an age-verification provider required in any
    target market? (ATK-01)
29. **Restore notice.** After a database restore from backup, fans' wins since the backup point disappear and spent spins
    return; reward codes delivered after that point may be handed out again. Is a notice to affected fans required, what
    must it say, and must affected creators be told? (ops3 Q7)
30. **Legal entity.** `LEGAL.operator` is the placeholder "FanFunnel" (`src/lib/legal.ts`); the Terms name Massachusetts law
    but no legal entity or postal address. Acceptable for a first real creator, and what must the pages show once an entity
    exists (name, registered address, company number)? (walk-anon Q5)
31. **Games.** (a) Does a fan choosing a box or card (mystery box) change the "tip-to-play with chance" read when the choice
    has no effect on the odds? (b) Does a weekly bonus count as a "prize for repeated play"? (c) Is the daily-door idea a
    "periodic drawing" under state sweepstakes law? (product report §6)
32. **Messages retention.** Chat messages are kept for as long as the creator account and the fan record exist (no
    age-based deletion). Is a fixed period (e.g. 12 months after the last message on a link) required or advisable? (TS-19;
    extends Q8)
