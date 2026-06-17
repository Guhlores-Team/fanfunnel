# Phase 9 — UX Pass & Hardening

_Date: 2026-06-16 · Branch: `feat/phase9-ux-and-hardening`_

A 16-item pass: bug fixes, UX changes, new features, real-time polish, plus a
full test run and a security audit. Approved via brainstorming on 2026-06-16.

## Locked decisions (from Q&A)

- **#1 Brand color** → **auto-pick readable text**. Keep the full picker; derive a
  legible foreground from the chosen color's luminance.
- **#5 Admin** → **keep Suspend (reversible) AND add a guarded Hard-delete
  (irreversible, type-email-to-confirm)**. Two distinct actions.
- **#6 Settings** → new **Settings** area: _Account_ (password, email, display
  name, notification prefs) + _Public profile (SFW link-in-bio)_ (avatar, slug,
  tagline, note, tip link, brand color) with **live preview**. **Move** the SFW
  editor out of _Boosts_ into Settings.
- **#16 Messages** → harden the **inbox/chat feature itself** (both creator and
  fan sides): reliable real-time, quick replies, send states, unread handling.

## Per-item design

### B — Correctness fixes
- **#2 Notification:** fire a confirmation/test notification when the creator
  grants permission; close the demo-mode gap (poll path never alerted).
- **#12 Debug console:** gate `DebugConsole`/`CrashCanary` to **admins only**
  (server-provided flag) and stop silently persisting via localStorage.
- **#13 Onboarding:** persist completion at the **account** level so deleting or
  archiving the tutorial wheel never resets it.
- **#15 Provably-fair hash:** wrap/truncate the commitment string so it stops
  clipping under the wheel.

### C — Theming + real-time
- **#1 Brand contrast:** centralize `brandVars(color)` → `--brand`, `--brand-ink`
  (readable black/white), `--brand-text` (contrast-safe accent). Replace
  hardcoded white-on-brand text. Apply everywhere `--brand` is set today.
- **#11 Wheel text color:** editable per-wheel label color; plumb through wheel
  config → `Wheel.tsx` render → persistence; sensible default.
- **#9 Real-time / no refresh:** remove `window.location.reload()`; mutations
  update local state optimistically + revalidate only the affected slice. Brand
  color applies live on change. Favorites → Prize Library is the first proof.

### D — Wheel-builder UX
- **#7 Empty wheel:** new wheels start with **zero** prizes (empty state + add).
- **#8 Drag handle:** drag prizes only from a corner grip; text fields stay
  selectable/editable.
- **#4 Pack stacking:** clicking a pack/preset N times **adds quantity**
  (10 spins ×5 = 50).

### E — Account / admin / settings
- **#5** Suspend + guarded hard-delete in admin.
- **#6** The Settings area above (with Boosts losing the profile editor).

### F — Fan growth
- **#3 Out-of-spins creator link:** add a creator link/section to `TopUpMoment`
  using the profile `tipUrl`.

### G — Messaging (#16)
- Harden inbox (creator) + chat (fan): real-time correctness, optimistic send +
  states, unread/read handling, quick replies.

## Execution plan (file ownership — prevents agent collisions)

**Foundation (orchestrator, first — everything depends on it):**
- `src/lib/theme.ts` (new) `brandVars()` + unit test · `src/app/globals.css`
  (brand-ink/brand-text) · `src/lib/games/wheel/types.ts` (label color) ·
  admin-flag server helper (#12) · onboarding account-level persistence (#13 model).

**Parallel leaf agents (disjoint files, after foundation):**
- **A. Fan spin page** — `SpinClient.tsx`, `TopUpMoment.tsx`, `Wheel.tsx`,
  `spin/[token]/page.tsx` → #3, #15, brand/text render (#1/#11).
- **B. Messaging** — `InboxPanel.tsx`, `ChatPanel.tsx`, `api/messages/*` → #2, #16.
- **C. Admin** — `AdminClient.tsx`, `api/admin/account/route.ts` → #5.
- **D. Packs** — `PackEditor.tsx`, `PackPresets.tsx` → #4.
- **E. Theming sweep** — `page.tsx`, `c/[slug]`, `share`, `verify`, `leaderboard`,
  `pending` → adopt `brandVars` (#1).

**Hub (orchestrator, sequential — only file touching all of these):**
- `DashboardClient.tsx` + new Settings components + `BoostsPanel.tsx` (remove
  profile card) → #6, #7, #8, #9, #11 (editor), #13 (UI), #1 (dashboard).

Child-component prop changes (InboxPanel/PackEditor/Wheel) keep stable external
interfaces; call sites reconciled at integration.

## Testing plan
Run **everything**: `npm test` (unit + RLS static lint) and all e2e
(`e2e`, `e2e:supabase`, `e2e:spin`, `e2e:a11y`, `e2e:login`). New unit tests for
`brandVars`, pack-stacking, onboarding persistence, odds-with-textcolor. Fix all
failures (systematic-debugging) before claiming done (verification-before-completion).

## Security audit plan
- `scripts/security/rls-runtime-test.mjs` + `src/lib/security/rls.test.ts`.
- Review every **new/changed endpoint** (admin delete, account settings,
  password/email change) for authz, RLS, input validation, and destructive-action
  guards. Secret + dependency scan. OWASP pass on the new surfaces.

## Risks & mitigations
- **Hub serialization** (`DashboardClient`): owned solely by orchestrator.
- **Destructive admin delete**: typed confirmation + server authz + cascade review.
- **Auth changes (password/email)**: use Supabase Auth flows; never expose service key.
- **Real-time regressions**: keep optimistic update + revalidate; preserve SSR guards.
