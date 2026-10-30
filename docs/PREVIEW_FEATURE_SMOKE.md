# Optional hosted Preview feature smoke

This is a **prepared manual test**, not evidence of a hosted pass. Run it only after the final two full local verification rounds, required CI, TEST migrations/history/exact generated types, hosted security negatives, and exact-SHA Preview deployment checks are complete. It does not authorize Production or a merge to main.

The existing login-ui job exercises a locally started app against real Auth. The separate `preview-feature-smoke` job exercises actual clicks on the immutable hosted Preview: creator login and Terms, the creator Focus grant wizard, fan consent and play, Scratch keyboard reveal, Bingo card/line bonuses, repeated request recovery, public verification pages, and a two-code private instant-delivery roundtrip. It complements those earlier gates.

## Integration and dispatch

Add these new source paths without changing app dependencies:

- `e2e/preview-feature-guards.mjs`
- `e2e/preview-feature-smoke.mjs`
- `src/lib/security/previewFeatureGuards.test.ts`
- This document.

Apply the separate additive `workflow-addition.patch` to `.github/workflows/e2e-supabase-ui.yml` **after** the frozen five-path Preview performance change. The patch adds only `preview_smoke_url`, `preview_smoke_expected_sha`, and the separate job. Preserve the complete original login-ui and preview-lcp jobs and inputs. OPS owns the downstream shared-file composition.

The unchanged shared `e2e/preview-lcp-guards.mjs` must have SHA256 `b5675aa69816b830783f49adeaef4ffb4f444361d4ddd4ba935425a6d0b308e5`. The runner checks that hash before any network request and reuses its source, Preview, project/team and TEST guards.

Dispatch the existing E2E login-UI workflow explicitly on `dashboard-redesign`, setting:

- `preview_smoke_url`: the exact immutable `https://fanfunnel-<9-character-id>-easy-simple-sites.vercel.app` deployment URL, without a path/query/fragment.
- `preview_smoke_expected_sha`: the full lowercase40-character checked commit SHA. It must equal the workflow's own GITHUB_SHA and checked-out HEAD, with no tracked modifications.

The stable branch alias and Production URL are refused. Authenticated Vercel metadata must say READY, Preview, expected project `prj_SYsq2wTEYY2EJuenGcfIRN3D2qPU`, expected team `team_nGs11yLViBWNrMoWyy12Xu5W`, matching immutable URL, `verifiedCommitSha`, and `verifiedGitBranch`. The production deployment reference and production aliases are checked separately. Preflight is performed again in the actual smoke invocation, not trusted from an earlier job step.

The job uses existing CI TEST credentials `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`; the URL must be exactly `https://snmcrmhgevfqggxdiomu.supabase.co`. It also requires a separately configured `VERCEL_TOKEN`. Missing credentials fail this explicitly requested job; they do not silently skip it. Provision that credential through an approved secure CI secret workflow. Do not copy an existing CLI auth token or print its value. Root's separate credential review may choose a short-lived project-scoped token and revoke it after the checks. This preparation does not claim Vercel documents read-only token granularity.

## Additional prerequisite for private instant coverage

Do not dispatch the full smoke until root has verified the final0063 candidate and its actual post-deployment System health, and the owner has confirmed a secure backup of the original encryption key/version and stable fingerprint key. Legacy rows without an anchor or a mismatch require the existing reviewed recovery procedure first. No part of this test initializes, resets or overwrites an anchor, reads ciphertext/IV/fingerprints, repairs health, rotates keys or supplies cryptographic witnesses.

Before creating any Auth fixture, the controller performs one fixed-TEST read of only `canary_status`, `canary_checked_at` and `canary_failure_at`. It requires healthy status, no failure latch, and an actual observation no older than15minutes or later than the controller's clock. Missing, stale, future, invalid or unavailable health fails before fixture creation. This read is not an independent key validation, proof of an owner-held backup, or proof that all other operational invariants are healthy; the root prerequisites still apply. Metadata-only `--preflight` retains its original two Vercel reads and does not query health or create a fixture.

## Fixture and actual browser flow

The Node controller pre-generates the exact disposable Auth UUID before creation, supplies a random password and a synthetic `e2e-feature-smoke-<workflow run>-...@fanfunnel.test` email, and uses `email_confirm:true`. It never calls signup, invite, reset, OTP email, or any email-sending method. Only that created profile is approved/activated as role creator and granted server-controlled wheel/Scratch/Bingo features. Notifications are disabled only on that fixture. No owner account, owner data, admin role, MFA factor, existing pilot or deployment setting is changed.

The real Preview password UI establishes the actual session. The app issues its own creator actor contexts through existing authenticated helpers. No browser actor/context/assurance hints are minted or supplied by the smoke. A fresh unenrolled creator is permitted at AAL1 by the current account-security contract; the test does not enroll MFA or reuse an owner's session.

The existing Focus/Scratch/Bingo fixtures use benign manual fulfilment with zero cost and unlimited stock. The additional instant fixture uses exactly two generated nonredeemable dummy code values and zero cost. Values stay in controller/browser memory and are never reported. All wheels/prizes/campaigns/passes/packs are created through the existing creator-auth HTTP APIs with stable economic request IDs. Stored wheel and prize IDs are consumed from the real app responses; draft IDs are not assumed authoritative. Every fixture wheel is pinned by its own campaign, so a newer scheduled/active game cannot redirect an older fan link.

The browser then performs:

1. Creator login and actual creator Terms acceptance, checked against the stored fixture profile.
2. A5-spin ordinary Focus pack granted through the actual Fans drawer wizard and confirmation controls. A separate anonymous fan context accepts age/Terms, clicks play, observes one focused-spin consumption, repeats the identical API request/status without another debit, and opens the actual public fairness page.
3. A separate Scratch fan accepts consent, clicks play, verifies the displayed nine cells match the committed presentation, uses the keyboard Reveal all control, recovers the identical result, and opens the actual public scratch proof.
4. A separate Bingo fan accepts consent and plays normally, checking visible card marks and bonus counts against each real response. The first card and any completing play are replayed, and primary/bonus public verification pages are opened. It stops at the first completed line with at most36 paid plays; it never changes seeds, outcomes, marks, counters or existing cards. If no line occurs within36 plays, the smoke fails honestly with `BINGO_LINE_NOT_OBSERVED_WITHIN_BOUND`. This is a probabilistic bounded fixture, not a guaranteed random outcome. The complete SQL/property suites remain necessary.

5. A separate ordinary wheel is configured through creator HTTP APIs before either paid play: the code prize has100 tickets and the other two prizes have0. Zero tickets are a supported ordinary-wheel setting; the server response is read back and checked, including an unlimited rare manual prize. Bingo's positive-weight fallback rules are unchanged. This does not alter a seed, existing spin, committed outcome or counter. Exactly two generated nonredeemable codes plus a duplicate are imported through the real code endpoint; a second paste checks durable duplicate rejection. Only masked hints/counts may return to the creator.
6. That fan accepts consent and performs two actual browser plays. Both displayed private values must belong to its own two-code pool and differ. Same-UUID request/status replay must preserve the reward, debit and receipt, while creator stock/used counts move2→1→0 and0→1→2. Actual public fairness pages must replay and their returned HTML must contain neither dummy values nor cipher/IV/fingerprint fields.
7. The fan opens **All instant rewards**, then the real **View reward** control for the first win. Its no-store response and visible dialog must return the original value; closing must remove the decrypted value from the page. Local and session storage are checked in memory for either dummy value after play and after re-view; they are never saved as artifacts. Missing token is400 under F5 validation; another newly created fixture fan's token is404. Replay/history/re-view must leave stock and credits unchanged, checked through the real creator fan-detail balance, paid-spin count and current grant edit-pass balance. These checks never reference an owner fan, existing inventory or a real redeemable code.

Chase is not enabled or granted. The fixture's own chase configuration is read before and after and must remain off. There is no debug/admin/pilot toggle. Instant link/text UI and large history pagination remain covered by the existing local suites; this bounded hosted addition specifically verifies code configuration, real server encryption/decryption, assignment, secrecy and re-view.

## Privacy and network boundary

Browser requests are restricted before transmission to the verified immutable Preview origin and the fixed TEST Supabase origin. Node admin traffic is fixed to TEST with redirects refused; authenticated Vercel metadata reads stay in the parent controller. Chromium receives the shared filtered environment, retaining proxy/CA/runtime settings and excluding key/token/secret/password/credential variables. DEBUG/PWDEBUG are removed before browser actions.

No screenshots, HAR, trace, session/storage-state files, request/response bodies, private URLs, tokens, credentials, emails, reward values or raw Playwright/browser exception messages are written. Browser errors and blocked requests are counted only. Reports contain fixed step/error codes, source/deployment provenance, play/bonus counts and cleanup booleans. The upload step is restricted to `e2e/artifacts/preview-feature-smoke/`, never the general e2e artifact tree.

## Cleanup and failure recovery

Cleanup first confirms the exact pre-generated fixture Auth UUID and synthetic email. It discovers only that owner's media, removes any known media through the real owned-media deletion API, and verifies creator_media, live creator_storage_objects and public Storage listings before deleting Auth. No bytes are uploaded by the smoke. Any unexpected avatar/object/folder, unknown count, denied listing, partial removal, or unconfirmed create is a failure; Auth and durable recovery metadata are retained instead of pretending cleanup completed.

Only after zero public bytes and zero live media/storage metadata are proven does the controller delete the disposable Auth user and verify a404. Database cascades remove fixture business rows and actor contexts. No direct context-table cleanup is used. A cleanup failure exits nonzero and is present in the sanitized report.

If the process is externally terminated, or a create/delete response is ambiguous, inspect TEST manually by the workflow-run synthetic email prefix and original Auth creation audit trail before retrying cleanup. Recover only the isolated fixture, verify ownership, and remove public bytes before Auth. The report deliberately contains no private fixture identifier or email. Never use broad deletion, a guessed owner ID, an owner login, or a fresh fixture as proof the old one was cleaned.

Success requires all browser flows (including the two-code instant flow), request/public replay checks and cleanup to pass. A prepared source review, mock/PG pass, preflight pass, public-page check or generic login CI alone must not be described as a hosted feature-smoke pass.
