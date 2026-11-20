# TEST maintenance scheduler preparation

This prepares a durable daily TEST scheduler after the final0063 and small-fix Preview has passed all release gates. It has not activated a scheduler, enabled a hosted extension, configured a hosted secret, called a Preview maintenance endpoint, or sent email. There is no application schema change, migration number or npm dependency.

The owner-facing outcome is daily authenticated maintenance of the TEST database: retention, durable storage retries and0063 key/inventory/reservation/credit checks. Vercel Cron runs on Production; a new scheduled GitHub workflow on this feature branch would not run. This uses Supabase's database scheduler instead. The existing `e2e-supabase.yml` already exists on the default branch, so its reviewed `workflow_dispatch` extension can be dispatched for `dashboard-redesign` without adding a new default-branch workflow or merging to main. Existing Supabase, spin-integrity and RLS jobs remain unchanged and run first.

## Fixed targets and credentials

All database requests are compiled to `https://api.supabase.com/v1/projects/snmcrmhgevfqggxdiomu`. No project-ref input controls the destination. The environment's ref must also match that exact TEST constant. The only scheduled application URL is:

https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/api/cron/retention

It sends GET, not POST, with a Bearer credential loaded from Vault at execution. The command contains a Vault name, never the secret value. HTTP timeout is bounded at60 seconds. The fixed job name is `fanfunnel.test.maintenance.v1`; the dedicated Vault name is `fanfunnel.test.maintenance.cron-secret.v1`. The schedule is04:17 UTC daily, and setup refuses a non-UTC/GMT Cron timezone.

Repository secrets `SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN` and `FANFUNNEL_TEST_CRON_SECRET` are optional until maintenance is requested. A requested setup/status job fails if any required credential is absent; it never quietly skips. The existing Supabase management credential is reused. No service-role or anon key is needed by the new job.

`FANFUNNEL_TEST_CRON_SECRET` must match the deployed Preview's `CRON_SECRET`, configured as Sensitive, targeting only Preview, with either a `dashboard-redesign` override or the generic Preview value. Production values must remain unchanged. Sensitive values cannot be read back through the metadata API: metadata proves scope/type, and a successful authenticated request to the verified immutable Preview proves credential acceptance. An environment change newer than the deployment requires a new verified Preview deployment first. Operators use secure environment/Actions secret controls; keys and codes must never be pasted into chat or screenshots.

Operator links: [Actions secrets](https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions), [Vercel environment settings](https://vercel.com/easy-simple-sites/fanfunnel/settings/environment-variables), [TEST Supabase](https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu), [existing integration workflow](https://github.com/Guhlores-Team/fanfunnel/actions/workflows/e2e-supabase.yml). Root should give the nontechnical owner only the next required secure step after reviewing this concrete preparation.

## Release and identity gates

Root may activate only after the final0063/3d source, migrations, complete verification twice, CI and actual Preview have been verified. Select branch `dashboard-redesign`, action `setup` or `status`, and provide the exact full40-character checked/deployed SHA in `maintenance_expected_sha`. Default action `off` performs no scheduler operation. Existing real-Supabase tests must pass before the optional job starts.

The script independently requires the manual event, repository, branch, native GitHub SHA, clean tracked checkout and expected SHA to agree. Authenticated Vercel reads verify stable alias, immutable deployment, project `prj_SYsq2wTEYY2EJuenGcfIRN3D2qPU`, team `team_nGs11yLViBWNrMoWyy12Xu5W`, READY state, Preview target, custom verified commit/branch metadata, and separation from the current Production target/alias. Redirect aliases are refused. The alias is reread, and setup repeats provenance immediately before configuration. The shared performance guard is reused without modification.

The script verifies TEST project identity/health through the Management API, checks the0063 health table/RPC, then examines extension availability and existing grants before making changes. Existing namespace/job/secret mismatches fail before setup mutation. Setup also performs one authenticated maintenance invocation on the verified immutable Preview and requires HTTP200 plus completed healthy application checks before scheduling. That invocation is deliberate TEST cleanup, not a synthetic dry run or proof of a scheduled execution. Status makes no application request and performs no platform mutation.

## Platform dependencies and access

Supabase must offer `pg_cron`, `pg_net` and `supabase_vault`, with its normal `extensions` schema and Cron run logging. `pg_cron` needs the platform's supported preload/database/worker configuration; the script does not restart a database, change shared preload settings or adjust global timezone. If platform requirements are incompatible, setup refuses for operator review.

Only missing extensions are enabled. Their schemas, tables, sequences and functions are immediately restricted from PUBLIC, anon, authenticated and service_role in the same installation transaction; the PostgreSQL scheduler/extension owners retain access, with explicit postgres access needed for the job. Existing shared extension policies are never silently changed. Existing unsafe Vault/pg_net privileges, direct API-role writes to Cron job metadata, foreign schemas, unexpected Vault triggers or incompatible Cron contracts cause a concrete refusal before activation. An operator must review existing consumers and a separate hardening plan before retrying; this preparation does not authorize blindly revoking another feature's privileges.

Protecting `net.http_request_queue` matters: pg_net's published defaults grant PUBLIC table access, and its transient request headers contain the Bearer credential. Vault encryption alone cannot protect those headers. Both the plaintext Vault view/functions and net queues/results/functions must remain inaccessible to all API roles, including service_role. The scheduled command rechecks private grants and Vault trigger compatibility before each enqueue, and refuses to enqueue if protection has regressed.

## Atomic setup and bounded witnesses

Management requests use JSON bodies and bind parameters. Secret values are parameters, never embedded in SQL text, cron commands, shell arguments, reports or error logs. Raw API payloads, SQL errors and exception messages are never printed. Public evidence includes only fixed states, source/Preview provenance, timestamps, request/run IDs and redacted health counts.

The platform contract is checked against pg_cron's published job defaults, named-job unique constraint and cache-invalidation trigger. `cron.schedule(name,...)` is an upsert, so setup deliberately inserts a missing owned row with `ON CONFLICT DO NOTHING` and the normal trigger/default semantics. A transaction-aborting guard prevents a concurrent conflicting insert from leaving a newly created Vault record without its job. It never overwrites an existing job or changes a mismatched secret. Private-access guards are rechecked inside the same secret/job creation statement, as well as before each scheduled enqueue. A transport timeout can leave commit outcome uncertain; inspect status and existing metadata rather than claiming setup completed. Exact existing configuration is idempotent.

The job locks only its owned Vault record through the decrypted view, validates its name/version/metadata and enqueues the request in the same transaction as recording a witness. The description holds only the last eight `{requestId, runId, queuedAt}` records. The update targets only `description` and `updated_at`; it leaves secret ciphertext, nonce, key ID and plaintext unchanged. Vault0.3's published encryption AAD uses the record ID, not its description; the inspected source has no metadata rewrite trigger. Runtime refuses unexpected triggers. No application table or private schema is added.

The Cron source inserts a run-history row before starting the job, but can mark it `running` after the SQL begins. The command therefore accepts its latest nonterminal `starting/connecting/sending/running` run row and records that exact run ID. Status later requires the same job/run to have succeeded, allowing a bounded10-second start timestamp tolerance for that controller ordering. HTTP is not sent until the enqueue/witness transaction commits.

## Three distinct completion checks

`setup` reports phase `configuration_only`. It may succeed while `scheduledExecutionVerified` is false. Configuration and the manual credential probe do not prove the automatic job ran.

`status` separately reports:

1. Cron enqueue: exact recorded run ID/job ID, successful SQL run, queued timestamp within that run.
2. HTTP completion: exact pg_net request ID, bounded response status, no timeout/transport failure. Cron SQL success alone is insufficient.
3. Application completion: HTTP200, application `ok`, non-demo healthy0063 checks and a correlated `lastMaintenanceAt` timestamp from that HTTP response. Current stored health is shown separately.

The latest scheduled request must follow the current verified deployment and stable-alias assignment. An old run cannot prove a newly deployed Preview works. Current health must also be healthy for a successful status job. Otherwise status exits nonzero with redacted incomplete/failure evidence.

pg_net responses are unlogged and retained for approximately six hours by default; a crash can also remove them. Inspect status after the04:17 UTC run and before10:17 UTC, ideally around04:20–04:30. Missing/expired HTTP evidence is explicitly unverified, even when Cron says SQL succeeded or a health timestamp exists. Witness metadata stays bounded and durable, but does not claim a missing HTTP response succeeded. Upload the redacted Actions JSON artifact to retain observed completion evidence beyond the response window. No notification email is sent by this setup/status tool; existing app alerts remain a separate acceptance check.

## Exact rollback, never automatic

The reviewed `scripts/ops/test-maintenance-rollback.sql` is not called by setup, status or the workflow. Only after an explicit operator decision may root submit that exact SQL through the pinned TEST Management endpoint using a secure authenticated client. Do not paste it into an unverified project or run it against Production.

It locks the fixed namespace, verifies the exact job metadata and SHA256 of the reviewed command, and deletes only that owned job row, invoking the normal cache invalidation. A mismatched job is refused. Repeating it after removal is a no-op. It retains Vault ciphertext/history, extension configuration, other jobs and all app data. Unscheduling prevents future starts; an already running request may finish. There is no automatic data repair, financial mutation or secret rotation.

## Preparation verification and remaining acceptance

Pure tests fake every API and cover wrong project/ref/host/SHA/credentials/metadata before mutation, no overwrite, credential acceptance, failure redaction, expiry and the three completion states. Disposable PostgreSQL tests reproduce the published extension contracts, use real row locks and pgcrypto encryption, and fake extension workers/HTTP. They verify concurrent enqueues/status, bounded history, denied API-role access, metadata-only updates, missing/bad run metadata, HTTP failures/expiry and exact rollback. They do not install or exercise the actual hosted extension workers.

No TEST platform activation, real worker execution, deployed bearer match, scheduled HTTP result, email delivery or final audit is verified by this preparation. Root must review the frozen patch, integrate it without overwriting the separate performance workflow additions, complete release gates, configure credentials securely, run setup, and observe a real subsequent scheduled run with status evidence before declaring daily TEST maintenance working.

References: [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart), [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net), [Vault](https://supabase.com/docs/guides/database/vault), [Management query API](https://api.supabase.com/api/v1-json), [pg_cron tables/trigger](https://github.com/citusdata/pg_cron/blob/main/pg_cron.sql), [named-job uniqueness](https://github.com/citusdata/pg_cron/blob/main/pg_cron--1.2--1.3.sql), [worker ordering](https://github.com/citusdata/pg_cron/blob/main/src/pg_cron.c), [Vault metadata/encryption implementation](https://github.com/supabase/vault/blob/main/sql/supabase_vault--0.3.0.sql).
