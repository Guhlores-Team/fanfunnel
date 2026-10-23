# Design references

## `command-center/` — Creator Command Center (dashboard redesign)

Claude Design handoff bundle for the dashboard redesign (June–July 2026),
exported from the Claude Design project *FanFunnel Command Center* on
2026-10-23 and committed here because standalone Claude Design closes on
2026-12-14. Files are kept exactly as exported.

- Start with [`command-center/README.md`](command-center/README.md) (tokens, screen → component map,
  real-vs-mocked behavior spec), then [`command-center/PORTING_CHECKLIST.md`](command-center/PORTING_CHECKLIST.md).
- Open the `.dc.html` prototypes in a browser (they load React from unpkg and fonts from Google Fonts).
- `screenshots/` are the visual-diff targets.

**Port status:** Phase 1 (tokens + accessibility foundation) is on the
`dashboard-redesign` branch. Phases 2–8 are not started. The port must keep every
existing dashboard feature, edit control, animation, and bug fix in its
corresponding spot in the new layout.
