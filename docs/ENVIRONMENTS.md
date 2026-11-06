# Environments: which is which

FanFunnel has exactly two environments. Everything is paired: one branch, one Vercel target, one Supabase project.

| | **LIVE** (real users, real data) | **TEST** (try things safely) |
|---|---|---|
| GitHub branch | `main` | `dashboard-redesign`, and any other branch |
| Vercel environment | **Production** | **Preview** |
| Website | https://fanfunnel.vercel.app | `https://fanfunnel-git-<branch>-easy-simple-sites.vercel.app`, e.g. https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app |
| Supabase project | `ttlogfmogcccwiraaoae` (LIVE) | `snmcrmhgevfqggxdiomu` (TEST) |
| DB migrations applied by | CI `supabase` job, `production` step, on merge to `main` | CI `supabase` job, `test` step, on every PR |
| Error console (`?debug=1`, admins) | off: never shipped | on (`NEXT_PUBLIC_ENABLE_DEBUG=1`, Preview only) |
| Environment badge (top of every page) | none | "PREVIEW · TEST database" in teal. If it is **red**, the Preview is pointed at the wrong database: stop and fix the Vercel Preview env vars. |

## Rules
- Nothing reaches LIVE except a merge to `main`, after CI is green **and** the owner has tested the Preview (see `AGENTS.md`).
- A migration reaches TEST before the Preview is tested, and reaches LIVE before or at the merge.
- Vercel env vars:
  - **Preview** scope must hold the TEST project's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
  - **Production** scope must hold the LIVE project's.
  - **Development** uses TEST.
- `src/lib/envLabel.ts` maps the two project refs to the TEST/LIVE labels. Update it if a project is ever replaced.
