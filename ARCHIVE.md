# Branch archive — 2026-10-23

This branch exists only to keep every commit of the branches below reachable
after they were deleted during the repo cleanup. Its single commit has each
branch tip as a parent. Why each was archived: docs/BRANCHES.md on main.

Restore one: `git push origin <commit>:refs/heads/<branch>`

| Branch | Commit | Last commit date | Subject |
|---|---|---|---|
| `claude/auto-migrations` | `f76cd6a478fb34aa1c1778293f95723d2f3772f2` | 2026-06-30 | Enable RLS on schema_migrations reconcile table (advisor + contract) |
| `claude/branded-error-pages` | `460c1009c8f7e90089616f97158beb84fda39751` | 2026-06-30 | Make 404 more visual: decorative spinning prize-wheel + stronger hierarchy |
| `claude/chat-poll-flood` | `495c18f5a64ff2608bf5843149a06793e0b57e04` | 2026-06-30 | Cut fan-chat poll flood: slower intervals, visibility-gated, idempotent read |
| `claude/creator-spin-wheel-game-WAB9p` | `bf9192c792e65fd9a3fc9a39af08889853c963ec` | 2026-06-09 | Add Playwright visual walkthrough harness |
| `claude/deploy-workflow-rule` | `923f4af7a50cfec787e41fc05f9d869dcbe60c4f` | 2026-06-30 | Add deploy workflow rule (test on preview before prod) + PR template |
| `claude/fanfunnel-handoff-dwgt2m` | `6a2692d8c0914c37889782bb536944fcdaef76c6` | 2026-06-30 | Checklist: Phase 3 done — prod deploy 425c255 Ready, URL opens |
| `claude/forgot-password` | `f3bd0fd6d5082331af7104a56b88761368f90a83` | 2026-06-30 | Add self-serve password reset (forgot-password flow) |
| `claude/harden-wheel-save` | `3fea77b8de05d621ba184cf10aeccd29ad07bb0e` | 2026-06-30 | Add Supabase auth contract + self-promotion negative test |
| `claude/hex-color-wheel-crash-x85m5t` | `a6a2a1798d4cb4e9c382c7e74fe46530d8dc40f1` | 2026-06-23 | Add pre-release mega checklist from 4-angle review |
| `claude/migration-pipeline-probe` | `b03bfd7fd7182dcff94c77ceab1bf3aa31d13eee` | 2026-06-30 | Add migration-pipeline probe (0036) to verify auto-apply end-to-end |
| `claude/phase-3-polish-bugs-MICSm` | `f2cfa0902dad5e33bf14b7fd40e7b5988f5e41de` | 2026-05-31 | Add DEPLOY.md + combined idempotent SQL (0001-0010) for one-paste Supabase setup |
| `claude/preview-all` | `3b3df101a73f4ddcac0c13ac2869ae299fd7d9ed` | 2026-07-01 | Merge remote-tracking branch 'origin/claude/wheel-label-readability' into claude/preview-all |
| `claude/security-audit` | `8ce164235830c02846ba7ec6c7bdab67f4c42378` | 2026-07-01 | fix(chat): guard fan ChatPanel against out-of-order thread loads |
| `claude/wheel-label-fit` | `b82418941c9eb4325ab208e63a1b0ee6d9d0a327` | 2026-06-30 | Fix wheel slice-label overlap on many-slice wheels |
| `claude/wheel-label-readability` | `cfd278be0394a8dd6c9c897a35db6800cbd54260` | 2026-07-02 | Merge branch 'main' into claude/wheel-label-readability |
| `claude/wheel-label-size` | `9cdf03f3107c46d4bbbae61403d47851740adaa1` | 2026-06-30 | e2e: target rarity select by its 'legendary' option (label-size select is also select.ff-input) |
| `claude/wizardly-dijkstra-gx9xg3` | `ee7ae695fa4e8144385689bd56bea0ad3af1097a` | 2026-06-30 | fix(data): getWheel returns null instead of crashing when the wheel row is absent |
| `desloppify-api` | `0034b1781f266bbec36d9e54ba695187df979d8a` | 2026-06-23 | desloppify(api): shared route helpers, consistent errors, validation, rate limits |
| `desloppify-components` | `3209db45446846576e61ab245bf50da8a552a51e` | 2026-06-23 | Add submit guards, rollbacks, and specific error copy (M5/N6) |
| `desloppify-infra` | `2861a94302bde5c83ac066981728dd4ca2bb1c80` | 2026-06-23 | docs(N3),ci(N10): document ADMIN_EMAILS/FF_REQUIRE_SUPABASE; warn on skipped Supabase tests |
| `fix/security-backlog` | `4908f787ee38dd91c32be0cfc132531d1c93e25c` | 2026-06-17 | fix(security): audit backlog — spin-race, suspended-edit, org RPC lockdown |
