# Kickoff prompt for Claude Code

Paste this into Claude Code, run from the root of the `fanfunnel` repo, with the
`design_handoff_fanfunnel_dashboard/` folder present (or attach it).

---

You're implementing a redesign of our creator dashboard. The design references live in
`design_handoff_fanfunnel_dashboard/` — two HTML Design Components (`.dc.html`), reference
screenshots, a README, and a porting checklist.

**Read these first, in order:**
1. `design_handoff_fanfunnel_dashboard/README.md` — exact tokens, the `readableInk` accessibility
   rule, motion rules, the screen→component map, and the real-vs-mocked behavior spec.
2. `design_handoff_fanfunnel_dashboard/PORTING_CHECKLIST.md` — the phased plan we'll follow.
3. Skim the screenshots in `design_handoff_fanfunnel_dashboard/screenshots/`.

**Ground rules:**
- The `.dc.html` files are **design references, not code to copy**. Recreate them in THIS app's
  existing stack (Next.js + React + Tailwind), reusing our current components
  (`src/components/dashboard/*`, `ui.tsx`, etc.), hooks, and `src/app/globals.css` token system.
- Match the designs to high fidelity — pull exact hex/spacing/radii/type from the README.
- Do **not** change our spin engine, RLS, auth, or API contracts except the explicit wiring called
  out in the behavior spec. Don't ship the prototype's mock shortcuts.
- Work on a branch (`dashboard-redesign`). Keep each checklist phase a separate, reviewable commit/PR.

**Start with Phase 1 only** (token + accessibility foundation in `globals.css`, including the
`readableInk(hex)` util that fixes our tracked white-on-`--brand` contrast defect). When Phase 1 is
done, summarize what changed and **pause for my review before Phase 2**.

As you go: flag anything in the designs that conflicts with our existing patterns or data model, and
propose the idiomatic version rather than forcing the prototype's exact markup.
