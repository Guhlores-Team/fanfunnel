# Themed Preview LCP measurement

**Status: prepared; no hosted LCP measurement has run yet.** Source guard tests
and syntax checks do not establish Preview performance. The measurement remains
an open item from `docs/handoff/PROPOSALS.md` (theming performance guardrail).

This extends the existing `e2e-supabase-ui.yml` workflow, which already exists on
the default branch. Its existing login job, push/PR triggers and assertions are
unchanged. A separate job runs only for a manual dispatch with `preview_url`.
It never builds or serves a local application as a substitute for the Preview.

## Prerequisites and pending connection

Run only after the final source has passed both full verification rounds,
exact-SHA CI/TEST migration/history/type checks and the archive-based Preview
deployment gate in `PREVIEW_DEPLOY.md`. The branch must remain
`dashboard-redesign`; this script refuses `main`, other repositories, branch
aliases, Production and arbitrary hosts/projects.

The existing GitHub Actions TEST credentials are used:

- `NEXT_PUBLIC_SUPABASE_URL`: exactly the dedicated TEST project
  `https://snmcrmhgevfqggxdiomu.supabase.co`.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.

Authenticated Vercel metadata verification also requires **`VERCEL_TOKEN`**,
in the `--preflight` step only (SUP-5). That step runs before `npm ci`; the
measurement step refuses to run with the token set and accepts the deployment
only through the preflight record bound to this Preview, commit and workflow run
(`checkPreflightRecord` in `e2e/preview-lcp-guards.mjs`). Both jobs run in the
`test` environment, where the owner keeps `VERCEL_TOKEN` (docs/GO_LIVE.md section 2).
This change does not create, copy, configure or verify that credential. Secure
setup is pending the owner's/root's decision: prefer a team/project-scoped
credential limited to the required metadata reads where the provider supports
that scope. Do not describe a broad write-capable token as read-only. An existing
authenticated CLI preflight is another design option, but substituting it needs
a reviewed trusted-provenance mechanism; a hostname or unchecked JSON file is
not sufficient. Missing credentials make a requested job fail, never skip.

If the scoped credential is chosen, its value goes directly into
[GitHub Actions secrets](https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions),
never chat, a commit, an input field, an artifact or a browser console. No
credential setup should be inferred from this prepared workflow.

The Vercel token is used only by Node for GET requests to `api.vercel.com`.
Before any site or fixture call, the script verifies all of the following:

- Manual workflow dispatch on the expected repository/branch; full expected SHA
  equals `GITHUB_SHA`, the actual clean checkout HEAD and the deployment's custom
  `verifiedCommitSha`; `verifiedGitBranch` is `dashboard-redesign`.
- The deployment is READY, the exact immutable URL returned by Vercel matches
  the input, project is `prj_SYsq2wTEYY2EJuenGcfIRN3D2qPU` and team is
  `team_nGs11yLViBWNrMoWyy12Xu5W`.
- Target is explicitly Preview, never Production; deployment is not the
  project's current Production target and has no Production FanFunnel alias.
- Supabase configuration is pinned to TEST. Browser requests to Production or
  an unexpected origin are intercepted before they reach the network.

Custom deployment metadata is a provenance check, not proof that arbitrary
uploaded bytes match a Git commit. The preceding exact-source archive deployment
gate supplies that source guarantee. Preview access protection must already
permit the test; this script neither changes protection nor passes bypass keys.

## Root dispatch instructions

After integration, push, successful required CI/TEST checks and a verified
immutable Preview deployment, confirm the branch still points at that exact
SHA. Dispatch the **existing** workflow on the branch with these two inputs:

```bash
gh workflow run e2e-supabase-ui.yml \
  --repo Guhlores-Team/fanfunnel \
  --ref dashboard-redesign \
  -f preview_url=https://fanfunnel-IMMUTABLE-easy-simple-sites.vercel.app \
  -f expected_sha=FULL_40_CHARACTER_CHECKED_COMMIT_SHA
```

Replace both placeholders with the actual inspected candidate. The script
rejects the placeholders and stable branch alias. Inputs contain only the public
immutable URL and commit SHA; never pass keys or cookies. Do not dispatch on
`main`. A later branch push makes an older expected SHA fail safely.

Follow the resulting run in
[GitHub Actions](https://github.com/Guhlores-Team/fanfunnel/actions/workflows/e2e-supabase-ui.yml).
The artifact is `preview-lcp-<full SHA>`, retained for seven days. Read both job
conclusion and `report.json`; successful numeric samples with failed cleanup are
not a completed check. The existing login job still runs according to its
original behavior.

## What is measured

The script creates one confirmed, approved, active **creator** in TEST with a
strong generated password and `email_confirm: true`; no email is sent. It signs
in through the real Preview form and accepts the real Terms prompt if required.
It checks that the session sees this fixture's own public slug and that Terms
were recorded server-side. Its service key remains in Node and is never supplied
to the browser. The generated password is used only in the real login form;
the authenticated context's private session is never logged or exported.
Application/CI credential variables are also removed from Chromium's child
process environment; normal proxy and CA trust settings are preserved. API and
protocol debug logging is disabled before authentication.

The same real `/c/<fixture slug>` public page is sampled before and after:

1. Default Bricolage font and Glow preset, saved through the creator theme API.
2. Unbounded font and a benign deterministic 1280 × 960 abstract photo, uploaded
   through actual `/api/account/media` with the SFW attestation and selected
   through `/api/account/theme`. The application performs its real WebP pipeline.

State preparation waits for ISR to reflect the requested data attributes,
actual computed font and loaded selected font face, and the own TEST photo
background. These warm-up visits are outside the sample set. Each variant then
has **five** fresh anonymous mobile browser contexts, without cookies or service
workers. Every sample clears/disables the browser cache. The server/edge cache
is not claimed cold; each response's actual `x-vercel-cache` is reported.

Fixed lab settings: 390 × 844 viewport, DPR 2, mobile/touch emulation, 4× CPU
slowdown, 150 ms latency,200,000 download bytes/s and93,750 upload bytes/s, Chromium
cellular4g connection type, en-US locale, UTC timezone, dark color scheme and no
reduced-motion preference. Actual Chromium/Node/runner OS versions are recorded.

A buffered `largest-contentful-paint` observer is injected **before** navigation.
After selected fonts and the photo are ready, the page settles for 2500 ms; first
pointer input at the decorative top-left background finalizes the observation.
Only numeric timings/size, candidate element tag, theme/font confirmations and
cache condition are captured. No LCP resource URL, response body, headers,
password, key, cookie, bearer link, HAR, trace or storage snapshot is saved.
Only the fresh anonymous verified public page is screenshotted.

All five samples are retained. Median is the third ordered sample; nearest-rank
p75 is the fourth. Partial/missing/invalid samples fail instead of becoming a
summary. The report includes the themed-minus-default median and p75 deltas.
These are **lab observations**, not field p75, an all-device claim or a declared
performance budget. PROPOSALS specifies a Preview check rather than a numeric
threshold; this script does not invent a passing budget.

## Cleanup and failures

Cleanup runs in `finally`. A client-chosen Auth UUID is recorded before creation
so even a lost create acknowledgement has a precise cleanup target; the cleanup
checks both that UUID and its exact generated email before removing anything.
If an uncertain create has no observable user yet, absence cannot prove that it
will never complete; the job reports cleanup as unconfirmed for operator review.
It enumerates only this fixture's media, removes it
through the authenticated HTTP deletion route, confirms zero remaining media
rows and unresolved storage objects, then deletes and verifies deletion of the
fixture Auth user. Cascade cleanup removes its profile/business rows. No other
creator's data is selected for removal.

Uncertain upload/deletion work must preserve the 0058 storage contract: public
bytes precede Auth/metadata deletion. If cleanup cannot prove completion, the
manual job fails with a redacted code and a recovery-review flag. It does not
silently delete ahead of unresolved public bytes. The ephemeral account's
`public_tagline` and generated email prefix contain the numeric workflow run ID,
so an operator can locate only that TEST fixture for review without a password
or bearer URL in logs, including a failure before profile setup completed.
Avoid cancelling a running fixture operation; interrupted runners may require
the same TEST-only recovery review. Concurrency does not auto-cancel older runs.

No hosted result, connection completion or cleanup rehearsal is claimed by this
source change. Keep the owner/handoff LCP item pending until an actual final
immutable Preview run and its cleanup report have been reviewed.
