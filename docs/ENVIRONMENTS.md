# Environments: which is which

FanFunnel has exactly two environments. Everything is paired: one branch, one Vercel target, one Supabase project.

| | **LIVE** (real users, real data) | **TEST** (try things safely) |
|---|---|---|
| GitHub branch | `main` | `dashboard-redesign`, and any other branch |
| Vercel environment | **Production** | **Preview** |
| Website | https://fanfunnel.vercel.app | `https://fanfunnel-git-<branch>-easy-simple-sites.vercel.app`, e.g. https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app |
| Supabase project | `ttlogfmogcccwiraaoae` (LIVE) | `snmcrmhgevfqggxdiomu` (TEST) |
| DB migrations applied by | workflow **Supabase migrations**, job `db-migrations-production`, on every push to `main` (after the owner approves it in the `production` environment and a LIVE backup is verified) | workflow **Supabase migrations**, job `test`, on every PR (the `supabase` job of **E2E (real Supabase)** waits for it) |
| Error console (`?debug=1`, admins) | off: never shipped | on (`NEXT_PUBLIC_ENABLE_DEBUG=1`, Preview only) |
| Environment badge (bottom of every page, top on wide screens) | none | "PREVIEW · TEST database · `<short SHA>`" in teal. If it is **red**, the Preview is pointed at the wrong database: stop and fix the Vercel Preview env vars. A SHA ending in `unknown` means the CLI deploy forgot `NEXT_PUBLIC_COMMIT_SHA` (`docs/PREVIEW_DEPLOY.md`). |
| Search engines and link previews | `/`, `/c/<slug>`, `/terms`, `/privacy` indexable; `/spin`, `/share`, `/verify`, `/leaderboard`, the dashboard and every API answer `noindex` (`src/lib/security/indexing.ts`; `/share` is still fetchable by the link-preview bots) | nothing: `X-Robots-Tag: noindex, nofollow` on every response and a disallow-all `robots.txt` |
| Git-triggered builds | `main` only (`vercel.json`: every other branch is off; `docs/PREVIEW_DEPLOY.md`) | none: the stable Preview is a CLI archive deploy of a checked commit |

## Rules
- Nothing reaches LIVE except a merge to `main`, after CI is green **and** the owner has tested the Preview (see `AGENTS.md`).
- A migration reaches TEST before the Preview is tested, and reaches LIVE before or at the merge.
- Vercel env vars:
  - **Preview** scope must hold the TEST project's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
  - **Production** scope must hold the LIVE project's.
  - **Development** uses TEST.
- `src/lib/envLabel.ts` maps the two project refs to the TEST/LIVE labels. Update it if a project is ever replaced.
