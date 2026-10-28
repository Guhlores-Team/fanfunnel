# Deploy the checked Preview after TEST is ready

`dashboard-redesign` deliberately disables automatic Git deployments in
`vercel.json`. GitHub applies migrations to TEST and verifies generated types
before the checked source is deployed through the authenticated Vercel CLI.
This prevents the code and migration workflows from racing. Other branch
deployment settings, including `main`, are unchanged.

This procedure does not authorize a production deployment or a merge to `main`.

1. Complete both full verification rounds in `docs/handoff/HANDOFF.md`. Push only
   `dashboard-redesign`, preserving its draft PR.
2. Record the full commit SHA. Confirm its `verify`, `schema-drift`, `test`,
   `supabase` and `login-ui` jobs succeeded. The `test` job must successfully apply
   TEST migrations, list their history and compare generated types. Inspect any
   runtime-test skip warnings; a skipped test is not a successful test.
3. Fetch `origin/dashboard-redesign` and confirm it still points at the checked
   SHA. Deploy an archive of that exact commit, rather than an uncommitted
   directory. A suitable staging directory is under `/workspace/.tools/`, outside
   the checkout. It must contain tracked source only; never copy local credentials
   or `.env` files into it.
4. Use the installed authenticated CLI for project
   `prj_SYsq2wTEYY2EJuenGcfIRN3D2qPU`, scope `easy-simple-sites`, explicitly selecting
   the `preview` environment. Never use a Production target or create a new project.
   Native CLI 65.5.0 uses `--environment preview`:

   ```bash
   vercel deploy "$preview_source" \
     --project prj_SYsq2wTEYY2EJuenGcfIRN3D2qPU \
     --scope easy-simple-sites --environment preview --yes \
     --meta verifiedGitBranch=dashboard-redesign \
     --meta "verifiedCommitSha=$checked_sha"
   ```

   The staging directory must be outside every Git checkout. Omit recognized
   `githubDeployment`/`githubCommitRef` metadata: a branch-associated deployment
   can update its alias immediately. Native CLI 65.5.0 rejects `--skip-domain` for
   Preview deployments. The custom verification labels above record the source
   without requesting automatic branch aliasing. Recheck branch-specific Preview
   variable overrides before using this method; current Preview variables have
   no branch-specific overrides.

5. Wait for READY. Inspect deployment metadata and verify the project, Preview
   target, branch and full SHA before updating the stable Preview alias. Recheck
   the remote branch before assigning the alias; if it advanced, keep the older
   deployment off the stable alias and verify the newer commit first. The stable
   alias is only:

   `fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app`

   After verifying the candidate and remote SHA, assign only that hostname:

   ```bash
   vercel alias set "$immutable_preview_url" \
     fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app \
     --scope easy-simple-sites
   ```

   Check the remote SHA again afterward. Git reference reads and alias assignment
   are separate APIs; if a concurrent push intervenes, report the checked SHA
   actually deployed and repeat the newer commit's verification/deployment.

6. Verify the deployed site and report its actual URL and SHA. Real-device checks
   remain necessary for installed iPhone web push. Never change a Production
   alias, bypass Deployment Protection or generate a bypass secret for this task.

CLI authentication and secret values stay outside the repository. The manual
gate needs no extra CI token. Future automation may move this procedure into
GitHub Actions after securely configuring a suitably scoped deployment credential.

Vercel cron runs on Production deployments. A scheduled workflow on a feature
branch also does not run until its workflow exists on the default branch. Do not
claim daily TEST cleanup is scheduled merely because `vercel.json` has a cron;
TEST scheduling or a manual TEST-only check needs separate verification.

References: [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration),
[GitHub Actions with Vercel](https://vercel.com/guides/how-can-i-use-github-actions-with-vercel),
and [Vercel CLI deployments](https://vercel.com/docs/cli/deploy).
