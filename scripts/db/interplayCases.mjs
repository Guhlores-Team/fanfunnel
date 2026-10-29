// Game-resolution interplay matrix (A26). Each case is one creator with 1–4
// games and a fan link, evaluated through three real SQL paths plus the TS
// mirror (src/lib/data/wheels.ts via the recorded fixture):
//   issuance = _create_pass_grant_core's default wheel (fan_passes.wheel_id)
//   context  = _spin_attempt_context(pass)->>'wheelId' (prepare_spin_attempt)
//   spin     = _resolved_spin_wheel(pass) (commit_spin_attempt)
// `expected` encodes the agreed behaviour; `bug` would mark a case where the
// paths disagree (printed as KNOWN-BUG, fatal under INTERPLAY_STRICT=1) and is
// empty since 0061 made every path share one ranking; `surprise` marks agreed
// behaviour that needs clear UI.
//
// Wheel spec: k=wheel|scratch|bingo, active=is_active, from/until=hours relative
// to now (negative=past), archived, age=minutes since created_at (bigger=older),
// ready=false for an unpublished Bingo draft (never served, never pinnable).
// Letters sort A<B<C<D by id; `age` controls created_at independently.
// pin: letter | "cross" (another creator's wheel) | null. issue: "auto" (wheel
// chosen by the grant RPC) or a letter (explicit p_wheel). after: mutations
// applied after issuance (archive, schedule).
export const SURPRISES = {
  S1: "pass.wheel_id is a label, not routing: an open schedule, the active flag or a pin serves a different game than the one the link was minted for",
  S2: "a schedule window overrides the creator's active flag at play time, even for an unpinned link",
  S3: "a game whose only schedule is in the future or already expired still serves as the oldest-game fallback when nothing else is live",
  S4: "no DB guard stops a creator pinning another creator's wheel id; the resolver silently ignores such a pin and falls through",
  S5: "a pinned game is served regardless of its own schedule window (future or expired)",
  S6: "disabling the scratch or bingo feature leaves an existing game pinned/scheduled/active and fans keep playing it (grandfathered)",
  S7: "archiving the only live game turns the fan link into 'no_wheel' with credits intact",
};
// Fixed in 0061 (now asserted as correct behaviour, see docs/handoff/INTERPLAY_STRESS.md):
// ISSUANCE_IGNORES_SCHEDULE and ACTIVE_ORDER_MISMATCH (one shared ranking,
// _creator_default_wheel, tie-break created_at,id), A2_STALE_STOCK_SAVE
// (save_wheel_prizes expected_stock CAS) and CROSS_TENANT_HAPPY_HOUR (policy
// with-check + trigger + creator filter at play time).
export const BUGS = {};
const W = (k, extra = {}) => ({ k, active: false, from: null, until: null, archived: false, age: 60, ...extra });
export const CASES = [
  // --- single game
  { id: "one-wheel", wheels: { A: W("wheel") }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "one-scratch", wheels: { A: W("scratch") }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "one-active-scratch", wheels: { A: W("scratch", { active: true }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "one-future", wheels: { A: W("wheel", { from: 24 }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A", surprise: "S3" } },
  { id: "one-expired", wheels: { A: W("wheel", { until: -24 }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A", surprise: "S3" } },
  { id: "one-archived-after", wheels: { A: W("wheel", { active: true }) }, pin: null, issue: "auto", after: [{ archive: "A" }], expected: { issuance: "A", spin: null, surprise: "S7" } },
  // --- two games, flags and windows
  { id: "active-vs-blank", wheels: { A: W("wheel", { active: true, age: 10 }), B: W("wheel", { age: 90 }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "blank-blank-oldest", wheels: { A: W("wheel", { age: 10 }), B: W("wheel", { age: 90 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "active-vs-open-window", wheels: { A: W("wheel", { active: true }), B: W("wheel", { from: -24 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S2" } },
  { id: "active-wheel-vs-open-scratch", wheels: { A: W("wheel", { active: true }), B: W("scratch", { from: -24, until: 24 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S2" } },
  { id: "active-vs-until-only", wheels: { A: W("wheel", { active: true }), B: W("wheel", { until: 24 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S2" } },
  { id: "active-vs-future", wheels: { A: W("wheel", { active: true }), B: W("wheel", { from: 24 }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "active-vs-expired", wheels: { A: W("wheel", { active: true }), B: W("wheel", { from: -48, until: -24 }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "open-window-archived", wheels: { A: W("wheel", { active: true }), B: W("wheel", { from: -24, archived: true }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "two-active-same-order", wheels: { A: W("wheel", { active: true, age: 90 }), B: W("wheel", { active: true, age: 10 }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "two-active-id-vs-age", wheels: { A: W("wheel", { active: true, age: 10 }), B: W("wheel", { active: true, age: 90 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "overlapping-windows", wheels: { A: W("wheel", { from: -48, age: 90 }), B: W("wheel", { from: -24, age: 10 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "overlapping-windows-same-start", wheels: { A: W("wheel", { from: -24, age: 90 }), B: W("wheel", { from: -24, age: 10 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "scratch-active-vs-wheel-window", wheels: { A: W("scratch", { active: true }), B: W("wheel", { from: -1 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S2" } },
  // --- campaign pin
  { id: "pin-valid", wheels: { A: W("wheel", { active: true }), B: W("wheel") }, pin: "B", issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "pin-scratch", wheels: { A: W("wheel", { active: true }), B: W("scratch") }, pin: "B", issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "pin-over-schedule", wheels: { A: W("wheel", { from: -24 }), B: W("wheel") }, pin: "B", issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "pin-future-window", wheels: { A: W("wheel", { active: true }), B: W("wheel", { from: 24 }) }, pin: "B", issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S5" } },
  { id: "pin-expired-window", wheels: { A: W("wheel", { active: true }), B: W("wheel", { until: -24 }) }, pin: "B", issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S5" } },
  { id: "pin-archived", wheels: { A: W("wheel", { active: true }), B: W("wheel", { archived: true }) }, pin: "B", issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "pin-archived-with-schedule", wheels: { A: W("wheel", { active: true }), B: W("wheel", { archived: true }), C: W("scratch", { from: -24 }) }, pin: "B", issue: "auto", expected: { issuance: "C", spin: "C", surprise: "S2" } },
  { id: "pin-cross-tenant", wheels: { A: W("wheel", { active: true }), B: W("wheel") }, pin: "cross", issue: "auto", expected: { issuance: "A", spin: "A", surprise: "S4" } },
  { id: "pin-archived-after", wheels: { A: W("wheel", { active: true }), B: W("wheel") }, pin: "B", issue: "auto", after: [{ archive: "B" }], expected: { issuance: "B", spin: "A", surprise: "S1" } },
  { id: "pin-everything-archived", wheels: { A: W("wheel", { active: true }), B: W("wheel") }, pin: "B", issue: "auto", after: [{ archive: "A" }, { archive: "B" }], expected: { issuance: "B", spin: null, surprise: "S7" } },
  // --- pass.wheel_id explicit at issuance
  { id: "pass-explicit-vs-active", wheels: { A: W("wheel", { active: true }), B: W("wheel") }, pin: null, issue: "B", expected: { issuance: "B", spin: "A", surprise: "S1" } },
  { id: "pass-explicit-active-vs-scheduled-scratch", wheels: { A: W("wheel", { active: true }), B: W("scratch", { from: -24, until: 24 }) }, pin: null, issue: "A", expected: { issuance: "A", spin: "B", surprise: "S1" } },
  { id: "pass-archived-stored", wheels: { A: W("wheel"), B: W("wheel", { age: 10 }) }, pin: null, issue: "A", after: [{ archive: "A" }], expected: { issuance: "A", spin: "B", surprise: "S1" } },
  { id: "pass-archived-stored-only", wheels: { A: W("wheel") }, pin: null, issue: "A", after: [{ archive: "A" }], expected: { issuance: "A", spin: null, surprise: "S7" } },
  { id: "pass-explicit-then-schedule", wheels: { A: W("wheel", { active: true }), B: W("scratch") }, pin: null, issue: "A", after: [{ schedule: "B", from: -1 }], expected: { issuance: "A", spin: "B", surprise: "S1" } },
  // --- four games
  { id: "four-mixed", wheels: { A: W("wheel", { active: true }), B: W("scratch", { from: -24 }), C: W("scratch", { from: 24 }), D: W("wheel", { archived: true }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S2" } },
  { id: "four-pin-future", wheels: { A: W("wheel", { active: true }), B: W("scratch", { from: -24 }), C: W("scratch", { from: 24 }), D: W("wheel", { archived: true }) }, pin: "C", issue: "auto", expected: { issuance: "C", spin: "C", surprise: "S5" } },
  { id: "four-windows-latest-start", wheels: { A: W("wheel", { from: -72, age: 240 }), B: W("wheel", { from: -48, age: 180 }), C: W("scratch", { from: -24, age: 120 }), D: W("wheel", { from: -24, until: -1, age: 60 }) }, pin: null, issue: "auto", expected: { issuance: "C", spin: "C" } },
  { id: "four-all-active", wheels: { A: W("wheel", { active: true, age: 10 }), B: W("scratch", { active: true, age: 20 }), C: W("wheel", { active: true, age: 30 }), D: W("wheel", { active: true, age: 40 }) }, pin: null, issue: "auto", expected: { issuance: "D", spin: "D" } },
  // --- feature flag: scratch disabled after the scratch game is placed (S6)
  { id: "flag-off-pinned-scratch", wheels: { A: W("wheel", { active: true }), B: W("scratch") }, pin: "B", issue: "auto", after: [{ feature: "scratch", enabled: false }], expected: { issuance: "B", spin: "B", surprise: "S6" } },
  { id: "flag-off-scheduled-scratch", wheels: { A: W("wheel", { active: true }), B: W("scratch", { from: -24 }) }, pin: null, issue: "auto", after: [{ feature: "scratch", enabled: false }], expected: { issuance: "B", spin: "B", surprise: "S6" } },
  { id: "flag-off-active-scratch", wheels: { A: W("wheel"), B: W("scratch", { active: true }) }, pin: null, issue: "auto", after: [{ feature: "scratch", enabled: false }], expected: { issuance: "B", spin: "B", surprise: "S6" } },
  { id: "flag-off-only-scratch", wheels: { A: W("scratch") }, pin: null, issue: "auto", after: [{ feature: "scratch", enabled: false }], expected: { issuance: "A", spin: "A", surprise: "S6" } },
  // --- personal Bingo (0061) in the same ranking; a draft is never served
  { id: "one-bingo", wheels: { A: W("bingo") }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "active-wheel-vs-open-bingo", wheels: { A: W("wheel", { active: true }), B: W("bingo", { from: -24, until: 24 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B", surprise: "S2" } },
  { id: "pin-bingo", wheels: { A: W("wheel", { active: true }), B: W("bingo") }, pin: "B", issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "two-active-bingo-vs-wheel-age", wheels: { A: W("bingo", { active: true, age: 10 }), B: W("wheel", { active: true, age: 90 }) }, pin: null, issue: "auto", expected: { issuance: "B", spin: "B" } },
  { id: "bingo-draft-never-served", wheels: { A: W("wheel", { age: 90 }), B: W("bingo", { ready: false, age: 10 }) }, pin: null, issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "pin-bingo-draft", wheels: { A: W("wheel", { active: true }), B: W("bingo", { ready: false }) }, pin: "B", issue: "auto", expected: { issuance: "A", spin: "A" } },
  { id: "flag-off-active-bingo", wheels: { A: W("wheel"), B: W("bingo", { active: true }) }, pin: null, issue: "auto", after: [{ feature: "bingo", enabled: false }], expected: { issuance: "B", spin: "B", surprise: "S6" } },
  { id: "bingo-archived-after", wheels: { A: W("wheel", { age: 90 }), B: W("bingo", { active: true, age: 10 }) }, pin: null, issue: "auto", after: [{ archive: "B" }], expected: { issuance: "B", spin: "A", surprise: "S1" } },
];
export const CASE_COUNT = CASES.length;
