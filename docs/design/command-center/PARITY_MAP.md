# Parity Map: current dashboard → Command Center redesign

Every feature, edit control, animation, and bug-fix behavior in today's dashboard, mapped to where it goes in
the redesign (`README.md`, `PORTING_CHECKLIST.md`, `*.dc.html`, `screenshots/`). The owner's rule is that
nothing gets dropped without someone deciding to drop it. Everything here was checked against code, with `src/` and `e2e/` identical
to `origin/main` @ `a92afbc`.

**How to use it:** during each porting phase, change `[ ]` to `[x]` at the start of a row once that row
works on the Preview deploy. Rows marked `needs placement` need a design decision before or during their phase.
They are not optional. A PR that drops one must say so and get owner sign-off.
Status values: `mapped` = the design shows it. `needs placement` = the design leaves it out, and a home is proposed.
`new in design` = the design adds it, and the notes say whether data or an API backs it.

**Totals (§2):** 237 rows. 142 are `mapped` (6 of them "mapped with changes", where the design's version would weaken
current behavior), 78 are `needs placement`, 16 are `new in design`, and 1 is out of scope. On top of that: 22 motion rows (§3),
50 bug-fix behaviors (§4) and 18 test selectors (§5).

**Path legend** (all repo-relative):
`DC` = `src/components/dashboard/DashboardClient.tsx` · `TP` = `…/dashboard/TodayPanel.tsx` ·
`GSC` = `…/dashboard/GetStartedChecklist.tsx` · `IB` = `…/dashboard/InvitesBanner.tsx` ·
`IP` = `…/dashboard/InboxPanel.tsx` · `FDD` = `…/dashboard/FanDetailDrawer.tsx` ·
`WS` = `…/dashboard/WheelSwitcher.tsx` · `TL` = `…/dashboard/TemplateLibrary.tsx` ·
`CP` = `…/dashboard/CampaignsPanel.tsx` · `PE` = `…/dashboard/PackEditor.tsx` ·
`PP` = `…/dashboard/PackPresets.tsx` · `BP` = `…/dashboard/BoostsPanel.tsx` ·
`SP` = `…/dashboard/SettingsPanel.tsx` · `AP` = `…/dashboard/AnalyticsPanel.tsx` ·
`CRM` = `…/dashboard/CrmPanel.tsx` · `IF` = `…/dashboard/ImportFans.tsx` · `QR` = `…/dashboard/QrButton.tsx` ·
`UI` = `…/dashboard/ui.tsx` · `ADM` = `src/components/admin/AdminClient.tsx` ·
`AGY` = `src/components/agency/AgencyClient.tsx` · `W` = `src/components/Wheel.tsx` ·
`CSS` = `src/app/globals.css` · `CC` = `docs/design/command-center/FanFunnel Command Center.dc.html`.

---

## 1. Section map

**Correction to the brief:** the current shell is **not** an 8-tab bar with a "Metrics" tab. It is a
**9-tab** `role="tablist"`: Today, Wheel, Fans, Prizes, Campaigns, Boosts, Inbox, Analytics, Settings
(`DC:225-235`). Metrics and Analytics were already merged into one Analytics tab (`DC:388-400`,
commit `47896fb`). Admin and Agency are separate routes, not tabs.

| Old tab / surface | Component(s) | New sidebar group › section | Split / merge notes |
|---|---|---|---|
| Today | `TP` | Run › Today | The design adds a pulse strip on top. The first-run checklist (`GSC`, currently above the tabs) moves inside Today. |
| (above tabs) GetStarted checklist | `GSC`, `DC:295-304` | Run › Today (first-run "Your first steps") | Goes from 3 steps to 5 steps (§3.2) |
| (above tabs) pending-prizes banner | `DC:306-322` | Sidebar Fulfilment badge + Today "Needs you now" fulfil card | The banner is removed. It currently shows on every tab except Prizes. |
| (above tabs) agency InvitesBanner | `IB`, `DC:289-293` | **no home**, needs placement | |
| Inbox | `IP` | Run › Inbox | 1:1 |
| Prizes (fulfilment queue) | `DC:674-950` (`PrizesPanel`, `RedemptionRow`) | Run › Fulfilment | Renamed. **README is wrong** to list `PendingClient.tsx` here. That file is the creator-approval request form for `/pending` (`src/components/PendingClient.tsx:9-197`) and has nothing to do with fulfilment. |
| Wheel (editor) | `DC:1881-2587`, `WS`, `TL`, `W`, `src/components/dashboard/OddsBar.tsx`, `src/components/dashboard/editorHelpers.ts` | Build › Wheels | The design shrinks WheelSwitcher's management card into chips. Archive, Restore, Delete, Set active, Duplicate and Schedule need a home. |
| Campaigns | `CP`, `PE` | Build › Campaigns | 1:1 |
| Fans | `DC:955-1876`, `FDD`, `IF`, `QR`, `PP` | Grow › Fans | Per-row controls (top-up, QR, Copy DM, tag edit, delete, per-wheel links) move into the drawer. |
| Boosts | `BP` | Grow › Boosts | **Merge:** the design moves Link-in-bio (slug, tip URL, tagline) back from Settings into Boosts. This reverses `77b7887` #6. Webhooks are **missing** from the design. |
| Analytics (merged Metrics + Analytics) | `DC:430-669` (`MetricsPanel`), `AP`, `CRM`, `src/components/dashboard/Sparkline.tsx`, `src/components/dashboard/Funnel.tsx` | Measure › Analytics | **Split:** the design draws only the MetricsPanel half plus a profit grid. Conversion funnel, CRM (LTV / whales / win-back), heatmap, prize-ROI table and cohorts are not drawn. |
| Settings | `SP` | Account › Settings | **Split:** account fields stay. Public-profile slug, tip and tagline go to Boosts. The note, brand-color card and live preview are not drawn. |
| `/admin` route (header link) | `src/app/admin/page.tsx`, `ADM`, `AdminClaim.tsx` | Account › Admin | Moves from its own route to a section of the dashboard. Access requests, role select and feature flags are not drawn. |
| `/agency` route | `src/app/agency/page.tsx`, `AGY` | **no home** | Not in the design |
| `/pending` route | `src/app/pending/page.tsx`, `PendingClient.tsx` | out of scope | Pre-dashboard approval gate. Leave unchanged. |

---

## 2. Feature parity tables

### 2.1 Shell, top bar, global

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Tab bar with 9 sections | `DC:225-235`, `DC:324-361` | Sidebar, 5 groups (`CC` navGroups) | mapped. The role changes from `tab` to nav plus `aria-current`, which breaks the e2e `[role=tab]` helper (§5) |
| [ ] Roving tabindex + Arrow/Home/End keys | `DC:186-202`, `DC:336-341` | Sidebar nav | mapped. Keep keyboard operation (see §4, `56814f0`) |
| [ ] Active tab scrolls into view (mobile scroller) | `DC:204-213` | Mobile bottom bar / "More" sheet | needs placement. Only matters if "More" scrolls. Otherwise retire it on purpose. |
| [ ] Fulfilment count badge on tab | `DC:349-353` | Sidebar Fulfilment badge | mapped. Currently `text-white` on `--brand`; switch to brandInk |
| [ ] Inbox unread badge on tab | `DC:354-358` | Sidebar Inbox badge | mapped. Same ink fix |
| [ ] Hide badges on first-run | — | Sidebar | new in design. Backed: pending and unread are already 0 |
| [ ] Auto-land new creators on the Wheel editor (once, unless the user already navigated) | `DC:169-184` | — | needs placement. The design lands on Today with the checklist. Owner decides whether to keep the auto-land on Wheels. |
| [ ] CTA navigation + scroll panel into view | `DC:215-223` | Section switch + scroll main to top | mapped |
| [ ] Live brand theming (shell `--brand` bound to editor wheel state) | `DC:239-247` | Root `--brand` (README State Mgmt) | mapped |
| [ ] Heading "Creator dashboard" + email line | `DC:248-256` | Top-bar title/subtitle per section (`CC` `meta`) | mapped |
| [ ] Demo-mode notice ("connect Supabase to go live") | `DC:253-255` | Workspace pill subtitle when `email` is null | needs placement |
| [ ] Workspace pill (avatar, handle, "Pro workspace", live dot) | — | Sidebar | new in design. Creators have no "handle". Use displayName (`/api/account`) and avatarUrl (`/api/public-profile`). The plan label and live dot have no backing. |
| [ ] "Get started" re-open button (dismissed and not complete) | `DC:258-267` | — | needs placement. Add a "Setup checklist" link in the Today header or sidebar footer |
| [ ] Admin link (only `isAdmin`, or demo) | `DC:268-275` | Account › Admin nav item | mapped. **Must stay gated on `isAdmin`.** The prototype shows it to everyone. |
| [ ] Sign out (`<form action=/auth/signout method=post>`) | `DC:276-285` | Sidebar footer | mapped. Keep the form POST |
| [ ] Agency invites accept/decline | `IB:38-96` | — | needs placement. Banner at the top of Today content, and/or a bell item |
| [ ] Pending-prizes banner "N prizes waiting… Open →" | `DC:306-322` | Today fulfil card + sidebar badge | mapped. Check that `/api/autopilot` emits an `open_fulfilment` card whenever pending > 0 (`src/lib/data/index.ts:3756`, `:3825`) |
| [ ] Code-split panels with skeleton fallback | `DC:47-65` | Each section | mapped. Keep `next/dynamic` |
| [ ] Overview poll every 12s + refresh on visibility | `DC:88-104` | Pulse, badges, Analytics | mapped |
| [ ] Search "Search fans, prizes…" | — | Top bar | new in design. **No backing.** There is no search API. Could filter loaded `/api/fans` and overview redemptions on the client, then route. |
| [ ] Notification bell + dot | — | Top bar | new in design. **No backing.** No notifications feed, no web push (no `PushManager`/service worker in `src`). This is behavior-spec #1. |
| [ ] "New fan link" primary button | — | Top bar → Fans mint form | new in design. Backed by `POST /api/passes`. Focus the handle input on arrival. |
| [ ] Mobile bottom tab bar (Today/Inbox/Wheels/Fans/More) | — | Mobile | new in design. The "More" contents aren't specified. They must hold Fulfilment, Campaigns, Boosts, Analytics, Settings, Admin (gated) and Sign out. |
| [ ] Mobile compressed top bar (avatar + title + bell) | `DC:248-256` | Mobile | new in design |

### 2.2 Today (+ first-run)

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Ranked feed from `/api/autopilot` | `TP:39-47` | "Needs you now" | mapped |
| [ ] Card icon | `TP:125-127` (emoji from API) | Icon tile (line icon) | mapped. Map `action.kind` to an icon. The API returns an emoji `icon`. |
| [ ] Card title + body | `TP:129-130` | Same | mapped |
| [ ] Impact tag (Fulfil / Re-engage / Timing / Tune) | — | Card title row | new in design. Not in the API. Derive it from `action.kind` (`src/lib/data/index.ts:3662-3667`) |
| [ ] CTA by kind: inbox / prizes / editor / boosts / campaigns; copy spin link for `dm_fan`/`copy_link` with toast, falling back to Fans | `TP:54-87` | CTA → section | mapped. Keep the clipboard path. `schedule_happy_hour` carries weekday/hour that are currently unused (could prefill). |
| [ ] Snooze 3d (`snoozeUntil`) | `TP:138-143` | — | needs placement. The design only has ✕. Add a "Snooze 3 days" overflow item next to ✕. |
| [ ] Dismiss (optimistic; `POST /api/autopilot`) | `TP:89-99`, `TP:144-149` | ✕ button | mapped. No rollback today |
| [ ] "{n} things worth your time, ranked" | `TP:119-121` | "{n} ranked by impact" | mapped |
| [ ] Loading "Loading your day…" | `TP:101-103` | — | needs placement. Skeleton cards |
| [ ] "You're all caught up" empty state | `TP:105-115` | — | needs placement. The design only covers first-run |
| [ ] Pulse strip: Revenue / Spins / Active fans / To fulfil, each with sparkline, trend chip and note | — (totals exist in `DC:460-466`) | Today top | new in design. Revenue and Spins sparklines and trends come from `/api/metrics` `trend`/`revenueTrend`; "today" is the last point. To-fulfil = `metrics.pending`, and "4h waiting" = age of the oldest pending redemption `at`. **"Active fans this week" has no backing** (`metrics.fans` is the all-time total, `src/lib/data/types.ts:250-267`). |
| [ ] Brand-glow bloom behind pulse | — | Today | new in design. Static. `CSS:68-72` `.brand-glow` can be reused |
| [ ] Checklist steps: build wheel / add fan / send link (server `wheelBuilt`, fans, spins) | `GSC:37-62`, `DC:129-137` | "Your first steps" (5 steps) | mapped with changes. Adds "Create account" (always done), "Share in bio" (**no signal**; needs public-profile slug set) and "Fulfil first win" (`metrics.fulfilled > 0`, backed) |
| [ ] Progress "x of y" | `GSC:72` | Same | mapped |
| [ ] Step CTA deep-link | `GSC:96-103` | Same | mapped |
| [ ] Done step strike + dim | `GSC:81`, `GSC:93` | Brand ring + check | mapped. Check uses brandInk (currently `#fff`, `GSC:87`) |
| [ ] "Dismiss — I'll explore on my own" (saved to the account) | `GSC:108-113`, `DC:145-153` | — | needs placement. Text link under the checklist |
| [ ] Completion stays sticky after wheel delete or archive (spec #5) | `DC:155-167` | Same logic | mapped. Already implemented |
| [ ] Show condition: not dismissed and not all done | `DC:295-304` | Prototype: `accountState=new` hides priorities | needs placement. Decide whether the checklist and priorities can show together |
| [ ] Zeroed pulse `$0/0/0/0` with "—" chips | — | First-run | new in design. Backed (metrics are zero) |

### 2.3 Inbox

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Auto-messages accordion: greeting + out-of-spins textareas (max 2000), Save with in-flight guard | `IP:318-412` (guard `IP:345`) | "Auto-messages · Greeting & out-of-spins ▾" bar | mapped. Only the collapsed bar is drawn. Keep the expanded form and `PUT /api/chat-settings` (RPC, `47896fb`) |
| [ ] Enable alerts (permission request + confirmation notification; hidden when granted/unsupported) | `IP:85-103`, `IP:236-243` | "Enable alerts" | mapped |
| [ ] Realtime `postgres_changes` subscription with poll fallback | `IP:105-179` | Same | mapped |
| [ ] Demo poll with diff-based inbound alerts | `IP:185-229` | Same | mapped |
| [ ] Inbound ping + browser Notification (skips the open thread and own sends) | `IP:68-83`, `IP:150-157` | Same; also a candidate source for the bell | mapped |
| [ ] Thread list: name, last message, unread badge | `IP:253-289` | Thread list | mapped. Avatar initials are new (derive from `fanName`). Badge `text-white` → brandInk (`IP:282`) |
| [ ] Optimistic unread clear on open | `IP:258-269` | Same | mapped |
| [ ] Selected-thread highlight | `IP:271-275` | Same | mapped |
| [ ] "Select a conversation" placeholder | `IP:302-304` | — | needs placement. The design always has an active thread |
| [ ] "Loading inbox…" | `IP:245-246` | — | needs placement |
| [ ] Empty "No messages yet" | `IP:247-251` | "No conversations yet" | mapped (copy change) |
| [ ] Conversation header (fan name) | `IP:522-524` | Name + meta line | mapped. The meta line ("spins · tag") is new; `FanThread` has no such fields (`types.ts:36`) |
| [ ] Bubbles: creator on brand, fan on ink-8% | `IP:526-539` | Same | mapped. Replace hard-coded `color:#fff` (`IP:532`, `IP:548`) with brandInk |
| [ ] Optimistic pending bubble "Sending…" / "Failed · Retry" | `IP:542-568`, `IP:469-514` | — | needs placement. Status line under the bubble |
| [ ] Quick-reply chips (4 canned) | `IP:11-16`, `IP:572-583` | — | needs placement. Chip row above the composer |
| [ ] Composer: Enter sends, maxLength 2000, `aria-label="Reply to this fan"` | `IP:585-593` | Composer | mapped |
| [ ] Send disabled while sending or empty | `IP:594-600` | Send | mapped |
| [ ] Auto-scroll to newest | `IP:463-465` | Same | mapped |
| [ ] Thread poll every 6s | `IP:456-461` | Same | mapped |
| [ ] Mobile master→detail (tap opens, back returns) | `IP:253` (list stacks above pane on small screens) | Mobile Inbox | new in design. Needs a back control |
| [ ] Open a specific fan's thread from elsewhere (drawer "Message") | — | Drawer → Inbox | new in design. `InboxPanel` has no preselect prop; add `initialFanId` |

### 2.4 Fulfilment (old "Prizes")

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Status filter chips Pending / In progress / Fulfilled / Cancelled / All (default Pending) | `DC:685`, `DC:746-764` | Filter chips | mapped. Active chip `text-white` (`DC:756`) → brandInk |
| [ ] Pending count in chip "(n)" | `DC:761` | — | needs placement. Keep the count on the chip |
| [ ] Search by fan or prize | `DC:766-775` | — | needs placement. Input in the filter row |
| [ ] Refresh button | `DC:738-743` | — | needs placement. Ghost button in the section header, or drop it on purpose (12s poll) |
| [ ] Row: rarity-tinted emoji tile, prize, rarity · fan · time | `DC:876-893` | Row | mapped |
| [ ] Status pill | `DC:900-904` | Row | mapped |
| [ ] Cycle CTA Start → Mark fulfilled → Reopen | `DC:815-827`, `DC:905-914` | Cycle button | mapped. The design labels it "Fulfil", but the e2e regex expects "Mark fulfilled" (§5). The in-progress CTA is emerald with white text (`DC:907-911`), which is a contrast risk. |
| [ ] Cancel → cancelled | `DC:915-922` | — | needs placement. Ghost "Cancel" or row overflow. The design's cycle has no cancelled state |
| [ ] Reopen from cancelled | `DC:819`, `DC:826` | — | needs placement. Same as Cancel |
| [ ] Overdue pill | `DC:863-869`, `DC:895-899` | — | needs placement. Red pill before the status pill |
| [ ] Note field (commit on blur/Enter, only if changed) | `DC:871-874`, `DC:926-935` | — | needs placement. Expandable row detail |
| [ ] Due-date picker | `DC:936-946` | — | needs placement. Same row detail |
| [ ] Optimistic PATCH + authoritative refresh | `DC:692-712` | Same | mapped. No rollback or toast on failure today |
| [ ] 15 per page, "Showing N of M", Load more | `DC:687-688`, `DC:794-808` | — | needs placement. List footer |
| [ ] Loading skeleton | `DC:778-784` | — | needs placement |
| [ ] Empty "Nothing here yet" | `DC:785-790` | "All clear here" | mapped |

### 2.5 Wheels — switcher (`WS`)

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Wheel list (includes archived) | `WS:39-48`, `WS:228-355` | Wheel chips | mapped. Chips only; the management actions below lose their home |
| [ ] "+ New wheel" | `WS:63-83`, `WS:204-211` | "+ New wheel" chip | mapped |
| [ ] Edit (load into editor) | `WS:261-267`, `DC:1984-1998` | Chip click | mapped. Neither version has an unsaved-changes guard when switching wheels (current gap) |
| [ ] "Active" pill | `WS:242-246` | — | needs placement. Badge on the chip (`text-white` → brandInk) |
| [ ] Set active | `WS:106-108`, `WS:268-277` | — | needs placement. Per-chip "⋯ Manage" menu |
| [ ] Duplicate wheel | `WS:114-130`, `WS:288-295` | — | needs placement. Same menu |
| [ ] Archive (2-step confirm) | `WS:132-147`, `WS:296-323` | — | needs placement. Same menu |
| [ ] Archived pill + Restore | `WS:247-251`, `WS:278-287` | — | needs placement. Same menu; show archived chips dimmed |
| [ ] Delete forever (2-step; 409 → "archive instead") | `WS:149-171`, `WS:324-350` | — | needs placement. Same menu |
| [ ] Prize count + schedule hint | `WS:253-256`, `WS:426-443` | — | needs placement. Chip tooltip or menu header |
| [ ] Active/archive help text | `WS:213-217` | — | needs placement. Menu footnote |
| [ ] Schedule: Active from/until, Save schedule, Always on (invalid-date guard) | `WS:173-198`, `WS:359-410` | — | needs placement. "Schedule" card under Title/Brand |

### 2.6 Wheels — editor, prize cards, preview, library

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Save bar: "● Unsaved changes" / "✓ Saved" (2s) / "All changes saved"; Save disabled when clean | `DC:1905-1938`, `DC:2147-2164` | Save bar (mobile: sticky) | mapped. The design only draws the unsaved state; keep all 3 states and the disabled button |
| [ ] Save failure toast | `DC:1933` | Same | mapped |
| [ ] Title (`data-testid="wheel-title-input"`) | `DC:2169-2176` | Title | mapped. Keep the testid |
| [ ] Brand color picker + hex (live re-tint) | `DC:2177-2191` | Brand color swatch + hex | mapped |
| [ ] Label text color + "Auto" | `DC:2194-2224` | — | needs placement. "Wheel style" row under Title/Brand |
| [ ] Label text size (Auto/S/L/XL) | `DC:2227-2245` | — | needs placement. Same row |
| [ ] Subtitle | `DC:2246-2252` | — | needs placement. Under Title |
| [ ] OddsBar (`role="img"`, per-segment aria-label) | `DC:2255-2262`, `src/components/dashboard/OddsBar.tsx:7-36` | Odds bar | mapped |
| [ ] Empty wheel + "Add your first prize" | `DC:2266-2284` | Same | mapped |
| [ ] Corner drag grip (arms drag) | `DC:1942-1946`, `DC:2322-2335` | Corner drag handle | mapped |
| [ ] Drag reorder, drop ring, edge auto-scroll | `DC:1948-1973`, `DC:2294-2319` | Same | mapped |
| [ ] ▲▼ move buttons (only reorder path without a pointer) | `DC:2336-2357` | — | needs placement. Keep for keyboard a11y; small stacked arrows by the grip |
| [ ] Emoji input | `DC:2358-2363` | Emoji | mapped |
| [ ] Emoji suggestion chips + "type or paste any emoji" tip | `DC:2399-2413` | — | needs placement. Popover on the emoji field |
| [ ] Prize name | `DC:2364-2369` | Prize name | mapped |
| [ ] ★ Save prize to library | `DC:2051-2073`, `DC:2370-2378` | ★ | mapped |
| [ ] ⧉ Duplicate prize | `DC:2093-2097`, `DC:2379-2387` | — | needs placement. Icon button next to ★ |
| [ ] ✕ Remove (min-2 guard + Undo toast) | `DC:2109-2135`, `DC:2388-2396` | ✕ | mapped. Undo needs the toast to stay up long enough (§6) |
| [ ] Rarity `<select>` (changing it re-fills tickets and default color) | `DC:2101-2108`, `DC:2435-2447` | Rarity pill that cycles on click | mapped with changes. The pill must call `changeRarity`; the prototype's `cycleRarity` doesn't re-fill weight. Name it for screen readers. e2e uses `selectOption('legendary')` (§5) |
| [ ] Tickets | `DC:2448-2456` | Tickets | mapped |
| [ ] Stock (∞; empty = null) | `DC:2457-2470` | Stock | mapped |
| [ ] Cost (dollars → cents; empty = null) | `DC:2415-2432` | Cost | mapped |
| [ ] Live odds % from `prizeOdds` (stock 0 → 0, the rest renormalize) | `DC:1897-1903`, `DC:2471-2480`, `src/lib/games/wheel/engine.ts:173-181` | Odds % | mapped. Spec #6 is **already done** in the engine. Don't port the prototype's naive tickets ÷ Σ. Optionally add an "Out of stock" hint (new). |
| [ ] Color picker + hex + "Reset to rarity color" | `DC:2483-2506` | Color + Reset to rarity | mapped |
| [ ] Description (shown on win) | `DC:2508-2515` | — | needs placement. Collapsible "More" inside the card |
| [ ] "+ Add prize" | `DC:1978-1980`, `DC:2521-2527` | Add prize | mapped |
| [ ] Balance odds (tier-curve `balanceOdds`, unit-tested) | `DC:2528-2536`, `editorHelpers.ts:117` | Balance odds | mapped. Don't port the prototype's equal split |
| [ ] Live preview `<Wheel>` (280px) | `DC:2540-2556` | Live preview canvas | mapped. **Use `W`, not the prototype's `drawWheel`**, which drops every label fix (§4) |
| [ ] Tickets/odds explainer | `DC:2550-2555` | Shortened copy | mapped |
| [ ] Library accordion | `DC:2561-2584` | "Prize & wheel library ▾" | mapped. Only the header is drawn |
| [ ] Save current wheel as template (name, Enter) | `TL:88-96`, `TL:141-169`, `DC:2016-2024` | Inside accordion | mapped (contents not drawn; restyle) |
| [ ] Wheel templates: Apply / Delete (confirm) | `TL:184-237`, `DC:2001-2014` | Inside accordion | mapped (contents not drawn) |
| [ ] Prize library: Add / Delete (confirm) | `TL:276-330`, `DC:2076-2088` | Inside accordion | mapped (contents not drawn) |
| [ ] "Save current prizes" | `TL:246-257`, `DC:2026-2049` | Inside accordion | mapped (contents not drawn) |
| [ ] Library refetch on ★ (`refreshSignal`) | `TL:79-86`, `DC:1909-1911` | Same | mapped |

### 2.7 Campaigns

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Create campaign (max 120, Enter, disabled when empty, error codes) | `CP:50-75`, `CP:80-107` | Create card | mapped |
| [ ] "Uncategorized" card (untracked revenue/spins) | `CP:111-135` | — | needs placement. Dashed card above the list |
| [ ] Loading skeleton | `CP:138-143` | — | needs placement |
| [ ] Empty "No campaigns yet" | `CP:144-148` | Same | mapped |
| [ ] "Inactive" pill | `CP:280-284` | — | needs placement. Next to the name |
| [ ] 8-cell stat grid (Revenue, ARPU, Spins bought, Spins played, Play-through, Unique fans, Fulfilled, Pending) | `CP:238-247`, `CP:323-332` | Stat grid | mapped |
| [ ] Top prize (rarity dot, ×count) | `CP:334-349` | "Top: … ×n" | mapped |
| [ ] Pinned-wheel select (PATCH `pinnedWheelId`) + hint | `CP:219-236`, `CP:352-371` | Pinned wheel select | mapped |
| [ ] Rename inline (Enter saves, Esc cancels) | `CP:179-202`, `CP:252-293` | Rename | mapped. Inline editor not drawn |
| [ ] Delete (2-step confirm) | `CP:204-217`, `CP:294-317` | Delete | mapped. The design is one click; **keep the confirm** |
| [ ] Spin packs toggle → PackEditor | `CP:374-391` | "Spin packs" | mapped. Contents not drawn |
| [ ] Add pack (label, spins, amount, bonus) with quantity stacking | `PE:46-97`, `PE:143-195` | Inside "Spin packs" | mapped. Spec #2 is **already done** |
| [ ] Pack row: Edit / Save / Cancel, Delete (confirm), re-sync when idle | `PE:228-383` | Inside "Spin packs" | mapped |

### 2.8 Fans — mint form, list controls, rows

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Fan name / handle | `DC:1113-1120` | "Fan handle" | mapped. The prototype auto-adds `@`; current code doesn't. Don't add it silently |
| [ ] Spins (min 1) | `DC:1121-1132` | Spins | mapped |
| [ ] $ per spin + "$x/spin · $y total" helper | `DC:1133-1152` | $/spin | mapped. Keep the helper line |
| [ ] Campaign select (defaults to newest active, never overrides a manual pick, truncate + title) | `DC:998-1003`, `DC:1153-1171` | — | needs placement. 4th field in the mint row; without it new links silently go "untracked" |
| [ ] Pack presets (stack ×N) | `DC:1180-1191`, `PP:26-103` | — | needs placement. Under the mint row when a campaign is set |
| [ ] Create account (in-flight disabled; `no_wheel` toast) | `DC:1031-1070`, `DC:1172-1178` | "Create" | mapped. The label change affects e2e (§5) |
| [ ] Explainer "You create the account; the fan never signs up…" | `DC:1108-1111` | — | needs placement. Card subtitle |
| [ ] Search by name | `DC:1095-1102`, `DC:1197-1204` | Search | mapped |
| [ ] Campaign filter | `DC:1205-1218` | Campaign | mapped |
| [ ] Tag filter (distinct tags) | `DC:1025-1029`, `DC:1219-1232` | Tag | mapped |
| [ ] Filters hidden when there are no fans | `DC:1195` | Same | mapped |
| [ ] Manage messages → DM templates modal (focus-trapped; list/add/delete; `{link}`) | `DC:1237-1243`, `DC:1299-1433` | "Manage messages" | mapped. Modal not drawn |
| [ ] Import CSV (paste or file, header detect, warnings, preview, 500 cap, uses mint campaign) | `IF:22-75`, `IF:91-233`, `DC:1246-1248` | "Import fans" | mapped. Form not drawn |
| [ ] Loading skeleton | `DC:1251-1257` | — | needs placement |
| [ ] Empty "No fans yet" | `DC:1258-1260` | — | needs placement. The design only draws the no-match state |
| [ ] Empty "No matches" | `DC:1261-1263` | "No fans match" | mapped |
| [ ] Row click → drawer | `DC:1546-1567` | Row click | mapped |
| [ ] Row meta: spins left · granted · links · last won (rarity color) | `DC:1553-1566` | Meta + "N spins" | mapped |
| [ ] Row avatar initials | — | Row | new in design. Derive from name |
| [ ] Total spent + campaign chips | `DC:1603-1615` | — | needs placement. Spent in the meta line; campaign chips are covered by drawer "By campaign" |
| [ ] Inline tag editor on the row | `DC:1492-1507`, `DC:1618-1620` | Read-only tag chips in the row; editing in the drawer | mapped |
| [ ] QR button (centered dialog, Download PNG, Copy) | `DC:1625`, `QR:13-141` | — | needs placement. Drawer action row |
| [ ] Copy DM from template (menu, fills `{link}`) | `DC:1510-1521`, `DC:1626`, `DC:1770-1844` | — | needs placement. Drawer action row "Copy DM ▾" |
| [ ] Copy link (primary token) | `DC:1846-1864` | Row copy icon | mapped. Use `copyToClipboard` |
| [ ] Open link ↗ | `DC:1865-1872` | — | needs placement. Drawer Links rows (`FDD` LinkRow has no Open) |
| [ ] Top-up: spins, $/spin, **wheel**, campaign (default = fan's campaign), presets, in-flight guard | `DC:1465-1481`, `DC:1632-1731` | Drawer "Top up spins" | mapped with changes. The prototype adds a flat +5. Real version needs a form with all fields and the guard |
| [ ] Per-wheel passes: wheel title, balance, campaign, link Copy/Open | `DC:1735-1764` | — | needs placement. Group the drawer Links by wheel (`FanDetail.links` has no wheel or balance, so it needs `passes`) |
| [ ] "NEWEST" badge on single link | `DC:1852-1856` | — | needs placement (minor) |
| [ ] Delete fan (2-step confirm) | `DC:1523-1540`, `DC:1569-1599` | — | needs placement. Drawer Safety section, under Block |

### 2.9 Fans — detail drawer (`FDD`)

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Right drawer on desktop / bottom sheet on mobile | `FDD:173-186` | Drawer / mobile bottom sheet | mapped. Already a sheet on small screens |
| [ ] Focus trap, Esc, restore focus; close focused first | `FDD:34-38`, `FDD:196-203` | Same | mapped |
| [ ] Header: name + "Fan details" | `FDD:187-195` | Same + avatar | mapped |
| [ ] 5 stats: Spins left, Granted, Total spins, Total spent, Last active | `FDD:161-170`, `FDD:212-227` | Stat grid | mapped |
| [ ] Action row Top up / Copy link / Message | — | Under stats | new in design. Top-up is backed (`/api/passes`); Copy is backed; Message needs the Inbox `initialFanId` prop |
| [ ] Tags: remove ×, presets VIP/whale/new, free-text add, case-insensitive de-dupe | `FDD:230-243`, `UI:13-124` | Tags | mapped. Active preset uses `text-white` (`UI:89`) → brandInk |
| [ ] Notes saved on blur only if changed, toast | `FDD:101-117`, `FDD:246-267` | Notes | mapped |
| [ ] Wins by rarity bar + legend | `FDD:270-310` | Same | mapped |
| [ ] By campaign | `FDD:313-358` | Same | mapped |
| [ ] Grant history + inline edit (spins, $/spin, campaign; re-sync when idle) | `FDD:361-374`, `FDD:474-601` | Grant history + Edit | mapped. Editor not drawn |
| [ ] Pending prizes | `FDD:377-405` | Same | mapped |
| [ ] Links + Copy | `FDD:408-421`, `FDD:455-470` | Same | mapped |
| [ ] Block / Unblock toggle | `FDD:134-156`, `FDD:424-446` | "Block fan" | mapped. **Must show the Unblock state** (`a1a7cec`) |
| [ ] "Fan not found" + per-section skeletons | `FDD:207-208`, `FDD:189-190`, etc. | — | needs placement |

### 2.10 Boosts

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Public slug `/c/<slug>` + Copy | `SP:599-610`, `SP:676-681` | Boosts › Link-in-bio | mapped. Moves back from Settings |
| [ ] Tip / buy-spins URL | `SP:620-628` | Link-in-bio | mapped. "Copy tip link" is new (trivial) |
| [ ] Tagline | `SP:611-619` | Link-in-bio | mapped |
| [ ] Open public page ↗ | `SP:668-675` | "Preview page ↗" | mapped |
| [ ] Save link-in-bio (slug normalized; "slug may be taken") | `SP:537-555`, `SP:659-665` | — | needs placement. The design has **no Save** in this card |
| [ ] Personal note to fans (atop the spin page) | `SP:629-637` | — | needs placement. Link-in-bio card |
| [ ] Live `/c/[slug]` preview | `SP:719-731`, `SP:742-811` | — | needs placement. Link-in-bio right column |
| [ ] Leaderboard toggle (optimistic, rollback, `aria-pressed`) | `BP:130-192` | "Toggle leaderboard" | mapped. Keep `aria-pressed` (e2e) |
| [ ] Leaderboard View ↗ / Copy link + no-slug hint | `BP:193-221` | — | needs placement. Under the toggle |
| [ ] Happy-hour create form: wheel, boost × (1-10, step 0.5), start, end, Schedule; invalid-date guard | `BP:226-350` | — | needs placement. The design draws only the list. Put an "Add happy hour" form at the top of the card |
| [ ] Happy-hour list + Remove | `BP:288-292`, `BP:352-373` | Happy hours list (status pill) | mapped. Remove needs placement. Scheduled/Live status is new (derive from startsAt/endsAt) |
| [ ] Wishlist demand | `BP:378-415` | Wishlist demand (bars) | mapped |
| [ ] Referrals (Referred / Credited / Bonus spins) | `BP:417-440` | Referrals | mapped |
| [ ] Webhooks: add (http(s) check), list, remove (rollback) | `BP:442-554` | — | needs placement. "Advanced: Webhooks" card above Danger zone. **e2e depends on it** |
| [ ] Danger zone: type `RESET`, then `router.refresh()` | `BP:43-118` | Danger zone | mapped. The design is one click; **keep the typed confirm** |

### 2.11 Analytics

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] 5-cell strip: Fans, Revenue, Spins played, To fulfil, Delivered | `DC:460-466`, `DC:484-493` | 5-cell stat strip | mapped |
| [ ] Spins trend + 14d/30d toggle | `DC:441`, `DC:497-526` | Spins trend card | mapped. Active toggle `text-white` (`DC:510`) → brandInk. `days` drives both trends |
| [ ] Revenue trend + period total | `DC:529-552` | Revenue trend card | mapped |
| [ ] Conversion funnel (Fans → Spun → Fulfilled) | `DC:555-569`, `src/components/dashboard/Funnel.tsx` | — | needs placement. Third card in the trend row |
| [ ] What's landing (top 6) | `DC:444-458`, `DC:574-600` | Same | mapped |
| [ ] Rarity mix | `DC:603-636` | Same | mapped |
| [ ] "Updates live as fans spin." | `DC:639` | — | needs placement (minor) |
| [ ] "No activity yet" empty state + CTA → Fans | `DC:471-479` | — | needs placement |
| [ ] Metrics skeleton | `DC:644-669` | — | needs placement |
| [ ] Profit grid: Revenue, Prize cost, Profit, Margin (90d) | `AP:125-161` | "Profit & prize costs · 90 days" | mapped |
| [ ] Warning when costs are incomplete | `AP:162-166` | — | needs placement. Under the profit grid |
| [ ] Prize ROI table | `AP:169-224` | — | needs placement. Under the profit grid; scrolls sideways on mobile |
| [ ] CRM lifetime value (Total / Avg) | `CRM:51-60` | — | needs placement. Analytics |
| [ ] CRM whales list + Copy link | `CRM:62-68`, `CRM:107-122` | — | needs placement. Analytics (or a Fans "Top spenders" tab) |
| [ ] CRM win-back list + Copy link | `CRM:70-77` | — | needs placement. Same |
| [ ] Best-time heatmap (90d, UTC) | `AP:49-115` | — | needs placement. Analytics; feeds the Today "Timing" card |
| [ ] Cohort retention | `AP:230-290` | — | needs placement. Analytics |

### 2.12 Settings

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Display name + Save (dirty check; required) | `SP:131-199` | Profile › Display name | mapped. The design has one "Save profile"; current code saves each field on its own |
| [ ] Handle | — | Profile › Handle | new in design. **No backing** (no creator handle). Drop it, or show the slug read-only |
| [ ] Email change: new email + **current password**, pending notice, error codes | `SP:201-302` | Profile › Email | mapped with changes. The design shows a plain email field. **Keep the step-up password and pending state** (`0a7e692`) |
| [ ] Password: current/new/confirm, at least 8, must match, error codes | `SP:304-397` | Security | mapped |
| [ ] Notification prefs newSpin / lowBalance / messages + Save | `SP:399-484` | Notifications toggles | mapped with changes. Design labels differ ("Email me when a prize is pending", "Push on a new fan message", "Alert when a prize is low on stock"). **Low-stock has no backing pref.** The design toggles look instant-save. |
| [ ] Avatar URL + upload (5 MB, image/*) | `SP:638-657`, `SP:814-856` | Profile "Change avatar" | mapped. The avatar is stored on the public profile (`PUT /api/public-profile`), so Save must call that route |
| [ ] Brand color card (picker, hex, Save color, live re-tint) | `SP:558-575`, `SP:688-716`, `DC:411-420` | — | needs placement. Keep a Settings "Brand" card, or document Wheels › Brand color as the only control (it's per wheel) |

### 2.13 Admin, Agency, other routes

| Feature / control | Current location | New home in redesign | Status / notes |
|---|---|---|---|
| [ ] Server role gate + AdminClaim bootstrap | `src/app/admin/page.tsx:10-31`, `src/components/admin/AdminClaim.tsx:15-37` | Account › Admin | mapped with changes. It's currently its own route. Keep the server-side `profiles.role` check (auth contract) |
| [ ] "Admins only" forbidden view | `ADM:158-174` | Same | mapped |
| [ ] Stat tiles: Accounts, Total fans, Total spins, Prizes pending | `ADM:177-182`, `ADM:214-226` | Cross-account stat strip | mapped |
| [ ] "+ New creator" modal (email, name, temp password `type=password`) | `ADM:205-210`, `ADM:494-582` | "New account" | mapped. Modal not drawn. It shows raw `data.error` (`ADM:519`), which is an existing hygiene gap |
| [ ] Access requests Approve / Reject (rollback, per-id busy) | `ADM:63-88`, `ADM:228-285` | — | needs placement. Admin, above accounts |
| [ ] Row: name, email, ADMIN / SUSPENDED badges | `ADM:358-374` | Row (initials, name, email · plan · fans, status pill) | mapped. "plan" has no backing |
| [ ] Role select creator/admin | `ADM:376-386` | — | needs placement. Row overflow |
| [ ] Suspend / Reactivate (optimistic, rollback, busy) | `ADM:91-126`, `ADM:387-397` | Suspend button | mapped |
| [ ] Per-account wheels / fans / spins / pending | `ADM:401-406` | Row meta (fans only) | mapped. The other three need placement |
| [ ] Feature-flag toggles (`FEATURES`) | `ADM:408-439` | — | needs placement. Row expand |
| [ ] Permanent delete with typed-email confirm | `ADM:130-156`, `ADM:441-489` | "Delete" | mapped. The design is one click; **keep the typed-email confirm** |
| [ ] Agency console: create org, tiles, invite/revoke, remove creator, staff seats + roles, "Can act for" scopes | `AGY:63-388` | — | needs placement. Keep `/agency`, link it from Account (owners/members) |
| [ ] Creator approval request (`/pending`) | `src/components/PendingClient.tsx`, `src/app/pending/page.tsx` | — | Out of scope. Leave as is |
| [ ] Debug console (`?debug=1` + admin) | `src/app/layout.tsx:4-6`, `src/components/debug/debug.ts:21-27` | Global | mapped. Spec #4 is **already done** |

---

## 3. Animations and motion

README rules: entrance is `translateY(10px)→0` over .5s with `cubic-bezier(.16,1,.3,1)`. **Never use opacity 0→1 as the only reveal; base opacity stays 1.** Hover lift is −2px. The drawer slides in over .34s. Toasts rise over .26s and dismiss after about 2.4s. Respect reduced motion.

| Animation / transition today | Where | Redesign home | Conflict with README? |
|---|---|---|---|
| [ ] `.reveal` = `ff-rise` (opacity 0→1 + translateY 15px, .62s, `both`) | `CSS:132-135`, `CSS:152`; used only by toasts `src/components/ui/Toast.tsx:78` | Toast rise | **Yes.** The `both` fill starts at opacity 0, so content can get stuck invisible. The prototype's `.reveal` is transform-only `ff-lift` with `opacity:1` (`CC` head `<style>`). The Phase-1 branch (`origin/dashboard-redesign`) still has the old `.reveal`. Change it to `ff-lift`. Fan and landing pages share it, so check them too. |
| [ ] `.reveal-scale`, `.ambient-glow`, `.ambient-float`, `.ticker-track` | `CSS:136-160` | Not used by dashboard surfaces | Leave them alone (fan/landing only). `.reveal-scale` is opacity-based too |
| [ ] Skeleton shimmer | `CSS:148-150`, `CSS:163-172`; used at `DC:49`, `DC:521`, `DC:543`, `DC:562`, `DC:650-662`, `DC:781`, `DC:1254`, `CP:141`, `PE:202`, `TL:175`, `TL:267`, `WS:222`, `FDD:190-411`, `QR:117` | Every loading state (design draws none) | No. Restyle onto `--s1/--s2` |
| [ ] Sparkline line draw-in (0.7s, JS reduced-motion gate) | `src/components/dashboard/Sparkline.tsx:48-52`, `:77-91` | Analytics trend cards. Optional for pulse sparklines (static in the design) | No |
| [ ] Wheel canvas spin (easeOutQuart 4.4s, tick sound, peg bounce, haptic, reduced-motion jump) | `W:88-90`, `W:334-398`, `W:413` | Not triggered in the dashboard (`result={null}`, `DC:2547`) | No. Keep `W` intact for the fan page |
| [ ] Live canvas redraw on every edit | `W:329-332` | Wheels live preview | No (README calls for it) |
| [ ] Drag card scale .99 + opacity .5 + brand drop ring (150ms) | `DC:2313-2319` | Wheels prize cards | No (feedback during drag, not a reveal) |
| [ ] Drag edge auto-scroll (rAF) | `DC:1948-1973` | Wheels | No |
| [ ] `scrollIntoView({behavior:"smooth"})` for active tab, CTA→panel, inbox newest | `DC:208-212`, `DC:221`, `IP:464` | Mobile nav / section routing / conversation pane | Minor: JS smooth scroll ignores the CSS reduced-motion clamp. Gate it on `prefersReducedMotion()` (`src/lib/sound.ts:145-150`) |
| [ ] Toggle knob slide (`transition-all`) | `BP:185-189`, `SP:460-464` | Leaderboard and notification toggles | No |
| [ ] `.btn-brand` hover brightness + press `translateY(1px) scale(.985)` | `CSS:100-113` | All brand-fill buttons | No. Text must use `--brand-ink` (`CSS:105`), not `text-white` overrides like `DC:907` |
| [ ] `.ff-input` focus ring transition | `CSS:83-89` | All inputs | No. The prototype adds a `:focus-visible` outline (Phase 1 branch has it) |
| [ ] Hover color/border transitions on secondary buttons | Throughout (e.g. `DC:271`, `WS:264`, `TL:204`) | Design hover .14–.16s background/border | No |
| [ ] Card hover lift (−2px + brand border) | — (Today cards are static `TP:123`) | Today priority cards, pulse | new in design. No conflict |
| [ ] Entrance lift on pulse and priority cards | — | `CC` `.reveal` (ff-lift .5s) | new in design. Transform only, so it complies |
| [ ] Drawer entrance | None: conditional mount, so `transition-transform` / `transition-opacity` classes do nothing (`FDD:175`, `FDD:185`) | `ff-slide` .34s + backdrop `ff-fade` .2s | new in design. Backdrop opacity fade is OK (not content). Mobile sheet should slide up |
| [ ] Modals (DM templates, QR, admin invite) | `DC:1349-1357`, `QR:85-98`, `src/components/ui/Modal.tsx:36` | Same | No animation today; none specified |
| [ ] Toast: stack, tone ring, click to dismiss, action button, **3.5s** default | `src/components/ui/Toast.tsx:37-109` (duration `:49`) | Single toast with brand dot, **2.4s** | **Behavior conflict:** 2.4s shortens the Undo window for prize removal (`DC:2118-2134`). Keep 3.5s (or longer) for toasts that have an action |
| [ ] "✓ Saved" for 2s; "Copied" for 1.5s | `DC:1928-1929`; `src/lib/hooks/useClipboard.ts:57` (resetMs) | Save bar; the design uses a "Copied ✓" toast | No |
| [ ] Global reduced-motion clamp | `CSS:174-182` | Same | Required by README. Keep it |
| [ ] `motion/react`, confetti, win sounds | Fan side only: `src/components/PityBeat.tsx:4`, `src/components/NearMissBeat.tsx:4`, `src/components/SpinClient.tsx` | — | No dashboard usage. The only dashboard sound is the inbox ping (`IP:69`) |
| [ ] Pending/failed bubble opacity (.7/.55); done-step opacity .6 | `IP:549`, `GSC:81` | Inbox; checklist | State styling, not reveals. OK |

---

## 4. Bug-fix behaviors that must survive the port

`47896fb*` means the behavior already exists in `47896fb`, the oldest commit in `main`'s visible history for these files (`docs/BRANCHES.md`). It was introduced earlier.

| Behavior | Commit | Where it lives now | Must be preserved in |
|---|---|---|---|
| [ ] Tablist roving tabindex + Arrow/Home/End | `56814f0` | `DC:186-202`, `DC:339-341` | Sidebar nav and mobile bar. Keep keyboard operation even with `aria-current` semantics |
| [ ] Reply input has `aria-label="Reply to this fan"` | `56814f0` | `IP:590` | Inbox composer (desktop + mobile) |
| [ ] Thread `onChanged` held in a ref (fixes runaway fetch loop) | `d8aecb4` | `IP:433-436` | Inbox conversation pane |
| [ ] Thread reqId guard (stale poll can't overwrite a just-sent message) | `d8aecb4` | `IP:439-447` | Inbox, including mobile detail view |
| [ ] Polling pauses while the tab is hidden | `d8aecb4` | `src/lib/hooks/useFetch.ts:115-117` | Any new pulse, badge or bell polling: build it on `useFetch` |
| [ ] Stale-response guard for overview and metrics | `a2f11fa` → `332dc51` (moved into useFetch) | `src/lib/hooks/useFetch.ts:74`, `:87`; `DC:88-104` | Today pulse, sidebar badges, Analytics |
| [ ] Top-up in-flight guard (no double grant or spend) | `a2f11fa` | `DC:1695-1718` | Drawer "Top up spins" form |
| [ ] Admin temp password uses `type=password` + `autoComplete=new-password` | `a2f11fa` | `ADM:551-560` | Admin "New account" |
| [ ] Admin access-request row restored on failure | `a2f11fa` | `ADM:63-88` | Admin access requests |
| [ ] Agency busy flag reset in `finally` | `a2f11fa` | `AGY:317-321`, `AGY:377-379` | `/agency` |
| [ ] Admin account patch is optimistic, rolls back, per-id busy | `332dc51` / `a2f11fa` | `ADM:91-126` | Admin Suspend / role / features |
| [ ] Hard delete needs typed email; server maps self / last-admin / mismatch errors | `77b7887` #5, `0a7e692` #2 | `ADM:130-156`, `ADM:441-489` | Admin "Delete" (the design shows one click) |
| [ ] Email change needs current-password step-up | `0a7e692` #1 | `SP:220-223`, `SP:280-290` | Settings › Profile › Email |
| [ ] Pack stacking: 3rd+ re-add stays an integer multiple; preset taps accumulate (×N) | `77b7887` #4, `0a7e692` #3 | `PE:61-83`, `PP:60-65`, `PP:93-97`, `src/components/dashboard/packHelpers.ts` | Campaigns › Spin packs; mint and top-up presets (spec #2 is already done) |
| [ ] Drawer `blocked` seeded from detail and reset when `fanId` changes | `a1a7cec` | `FDD:58`, `FDD:70` | Drawer Safety (Block **and Unblock**) |
| [ ] Error hygiene: server returns codes, client maps them to copy, never shows raw text | `a1a7cec` (server); client mappers | `SP:232-243`, `SP:329-338`, `SP:836-843`, `ADM:143-153`, `AGY:53-61`, `DC:1039-1043`, `CP:62-67`, `WS:153-158`, `IF:109-114` | Every redesigned form. Fix the leak at `ADM:519`/`ADM:562` while porting |
| [ ] Pending/fulfilled counts come from server count queries, not a truncated list | `a1a7cec` | Data layer → `metrics.pending` | Sidebar badge + pulse "To fulfil" must read `metrics.pending`. `DC:729` is list-derived, so don't copy it |
| [ ] Wheel never draws "undefined" for an empty label | `ffc50b9` | `W:196-197` | Wheels preview: use `W`, not the prototype `drawWheel` |
| [ ] Wheel labels: one radial line, per-label size, flip left half upright, cap lines to what fits, ellipsis only as last resort | `6452ba2`, `4cc4618`, `d58e8ca`, `003ee37`, `c30eb61` | `W:204-246`, `W:277-301` | Wheels preview + fan page. The prototype `drawWheel` (`CC` script) truncates at 12px and never flips |
| [ ] Half-typed hex can't crash the canvas (parseHex / shade / safeColor; label fill validated) | `77b7887` | `W:102-128`, `W:175-176` | Wheels brand and per-prize hex inputs |
| [ ] Per-wheel label color (`#11`) and size | `77b7887`, `c30eb61` | `DC:2194-2245`, `W:175-176`, `W:216-219` | Wheels "style" row (needs placement) |
| [ ] Rarity change re-fills tickets from the default and keeps a custom color | `47896fb` | `DC:2101-2108` | Wheels rarity pill (prototype `cycleRarity` skips the weight) |
| [ ] Drag only from the corner grip, so text stays selectable | `77b7887` #8 | `DC:1942-1946`, `DC:2294`, `DC:2322-2335` | Wheels prize card |
| [ ] Drag edge auto-scroll + brand drop ring | `47896fb` | `DC:1948-1973`, `DC:2313-2319` | Wheels prize list |
| [ ] Remove prize: minimum 2 + Undo via functional update | `47896fb*` | `DC:2109-2135` | Wheels ✕ + toast action |
| [ ] Duplicated wheel/prize keeps its name (no " copy") | `47896fb` | `src/components/dashboard/editorHelpers.ts:94-101` | Wheels duplicate actions |
| [ ] New wheels start empty with the "Add your first prize" state | `77b7887` #7 | `DC:2264-2284` | Wheels empty state |
| [ ] Favorited prize appears in the library immediately | `77b7887` #9 | `DC:1909-1911`, `DC:2065-2067`, `TL:79-86` | Wheels library |
| [ ] Prize library reads `{templates}` (used to always look empty) | in code (comment `TL:61-62`) | `TL:58-68` | Wheels library |
| [ ] Live brand re-tint while editing and on Settings save | `47896fb`, `77b7887` #9 | `DC:239-247`, `DC:411-420`, `SP:558-575` | Root `--brand`, Wheels brand field, brand card |
| [ ] Brand-adaptive ink and text (`brandVars`) | `77b7887` #1 | `src/lib/theme.ts:79-122`, `CSS:105` | Every brand fill. The README rule (max contrast vs `#160d12`) replaces the current 3:1-prefer-white threshold (`src/lib/theme.ts:83`) |
| [ ] Onboarding completion sticky; dismissal saved to the account and re-openable | `77b7887` #13; `47896fb*` | `DC:139-167`, `DC:258-267` | Today first-run (spec #5 is already done) |
| [ ] Top-up campaign defaults to the fan's campaign; mint form defaults to newest active campaign without overriding a manual pick | `47896fb` | `DC:998-1003`, `DC:1473-1478` | Fans mint form + drawer top-up |
| [ ] QR always opens as a centered dialog with backdrop (no edge clipping) | `47896fb` | `QR:85-98` | Drawer QR action |
| [ ] Dark `color-scheme` on native date/time pickers | `47896fb` | `CSS:93-97` | Fulfilment due date, happy hours, wheel schedule |
| [ ] Invalid partial `datetime-local` guarded before `toISOString` | `47896fb*` | `BP:256-263`, `WS:175-182` | Happy-hour form, wheel schedule |
| [ ] Hard-delete of a wheel with spins: 409 → "archive instead" | `47896fb*` | `WS:149-171` | Wheels manage menu |
| [ ] Notes commit only when changed (fan and redemption) | `47896fb*` | `FDD:101-117`, `DC:871-874` | Drawer notes, fulfilment row detail |
| [ ] Leaderboard toggle optimistic with rollback | `47896fb*` | `BP:151-170` | Boosts toggle |
| [ ] Auto-messages in-flight guard; saves via SECURITY DEFINER RPC route | `47896fb` | `IP:345`, `PUT /api/chat-settings` | Inbox auto-messages |
| [ ] Inbox: optimistic send + retry, optimistic unread clear, realtime → poll fallback, quick replies, test notification on enable | `77b7887` #16, #2 | `IP:85-103`, `IP:105-229`, `IP:258-269`, `IP:469-518` | Inbox |
| [ ] Webhook remove is optimistic and rolls back to its original index | `332dc51` | `BP:484-502` | Boosts webhooks (needs placement) |
| [ ] Invite accept/decline is optimistic, restores on failure, toasts | `332dc51` | `IB:38-62` | Invites (needs placement) |
| [ ] Shared `copyToClipboard` with `execCommand` fallback | `332dc51` | `src/lib/hooks/useClipboard.ts:14-38` | Every copy action. The prototype uses `navigator.clipboard` directly, and `SP:578-587` still does too |
| [ ] Shared focus trap (Esc, Tab cycle, restore) | `332dc51` | `src/lib/hooks/useFocusTrap.ts:33`, `FDD:34-38`, `DC:1314` | Drawer, mobile sheet, all modals |
| [ ] Sparkline respects reduced motion (SSR-safe) | `332dc51` | `src/components/dashboard/Sparkline.tsx:48-52` | Analytics + pulse sparklines |
| [ ] OddsBar segments use `role="img"` (axe `aria-prohibited-attr`) | `9ee5b0b` | `src/components/dashboard/OddsBar.tsx:24` | Wheels odds bar |
| [ ] Stock → odds renormalization | engine | `src/lib/games/wheel/engine.ts:14-20`, `:173-181`; `DC:1897` | Wheels odds % (spec #6 is already done) |
| [ ] Debug console only with admin + `?debug=1`, session-scoped; launcher bottom-left | `77b7887` #12, `5f99647` | `src/components/debug/debug.ts:21-27`, `src/components/debug/DebugConsole.tsx:194` | Global. The launcher (`fixed bottom-3 left-3`) will sit on the mobile bottom tab bar |
| [ ] Approval gate: unapproved users go to `/pending` | in code | `src/app/dashboard/page.tsx:31-34` | New shell page |

---

## 5. Test selectors to preserve (or update in the same PR)

| Selector / assertion | File | Risk under the redesign |
|---|---|---|
| `[role='tab']` count ≥ 7 | `e2e/journeys.mjs:22-25` | **Breaks** if the sidebar uses `aria-current` links/buttons |
| `clickTab(name)`: `[role='tab']` innerText `includes()` + `[aria-selected='true']` | `e2e/harness.mjs:207-226` | **Breaks** for the same reason. Rewrite to target `nav [aria-current]` by accessible name |
| `clickTab` names "Wheel", "Fans", "Analytics", "Boosts", "Prizes" | `e2e/journeys.mjs:28`, `:66`, `:81`, `:100`, `:226`, `:244`; `e2e/a11y.mjs:16`, `:34-37` | "Wheel" still matches "Wheels". **"Prizes" → "Fulfilment" breaks** |
| `select.ff-input` that has `option[value="legendary"]` + `selectOption` | `e2e/journeys.mjs:34-37`, `:47` | **Breaks** if rarity becomes a cycling pill |
| Rendered `[\d.]+%` odds change after a rarity change | `e2e/journeys.mjs:29`, `:38-45` | OK while odds % stays as visible text |
| `getByTestId("wheel-title-input")` | `e2e/journeys.mjs:53`; `DC:2172` | Keep the `data-testid` (the only one in `src`) |
| `button:has-text('Save wheel')`; body `/saved\|all changes saved/` | `e2e/journeys.mjs:56-61` | Keep "Save wheel" and the saved/all-saved copy |
| Fans: first `input.ff-input` is the name field | `e2e/journeys.mjs:67-68` | **Breaks** if the top-bar search input renders first with `.ff-input` |
| `button:has-text('Create account')` | `e2e/journeys.mjs:69` | **Breaks** with the design label "Create" |
| Analytics body `/spins played\|spins trend\|conversion\|what.?s landing/` + `/heatmap\|cohort\|profit\|prize cost/` | `e2e/journeys.mjs:84-95` | Passes on "Prize cost" alone, so it **won't catch** heatmap/cohort/CRM being dropped. Tighten it |
| Boosts: first `button[aria-pressed]` is the leaderboard toggle | `e2e/journeys.mjs:101-112` | Keep `aria-pressed` on the toggle, and keep it the first pressed button on Boosts |
| Fulfilment CTA `/^(Start\|Mark fulfilled\|Reopen\|Mark delivered)$/` | `e2e/journeys.mjs:229-231` | The design's "Fulfil" label doesn't match. Update the regex or keep "Mark fulfilled" |
| Boosts: last `input[type='url']` = webhook; `button:has-text('Add')` first; `button:has-text('Remove')` first; `text=example.com/hooks/e2e` | `e2e/journeys.mjs:245-260` | **Breaks** if webhooks are dropped. Fragile if a link-in-bio `type=url`, an "Add" or a happy-hour "Remove" appears earlier |
| Boosts: first `input[type='number']` = multiplier; `input[type='datetime-local']`; `button:has-text('Schedule')` | `e2e/journeys.mjs:267-288` | **Breaks** if the happy-hour create form isn't placed |
| Debug console `aria-label`s (Open / Debug error console / Close) | `e2e/journeys.mjs:121-129`; `src/components/debug/DebugConsole.tsx:199`, `:212`, `:238` | Unchanged (global) |
| Login lands on `/dashboard`; body `/creator dashboard\|today\|wheel\|fans/` | `e2e/login-ui.mjs:127-128` | OK ("Today" is in the sidebar) |
| a11y `DASH_ADVISORY = ["color-contrast"]` on 5 dashboard states | `e2e/a11y.mjs:24-37` | Once brandInk ships, remove the advisory so contrast blocks merges (Phase 8) |
| `readableInk(DEFAULT_BRAND) === "#ffffff"`; `brandVars` `--brand-ink === "#ffffff"` | `src/lib/theme.test.ts:38`, `:63` | **Must change** under the README rule (pink → `#160d12`). Already changed on `origin/dashboard-redesign` |
| `editorHelpers` / `packHelpers` unit tests | `src/components/dashboard/editorHelpers.test.ts`, `packHelpers.test.ts` | Keep. These are the balance and stacking guarantees |

---

## 6. Gaps and risks

**Current behavior the design leaves out (owner decision needed, counted as `needs placement` above):**
1. **Analytics depth.** Conversion funnel, CRM (LTV, whales, win-back), best-time heatmap, prize-ROI table, cohort retention and the costs-incomplete warning are all missing. That's about half of today's Analytics tab, and e2e won't notice they're gone.
2. **Wheel management.** Set active, Archive/Restore, Delete forever, Duplicate wheel and schedule windows are missing. Spec #5 (archive) assumes Archive exists.
3. **Editor fields.** Label color and size, Subtitle, Description, ▲▼ keyboard reorder, emoji suggestions and ⧉ duplicate prize are missing.
4. **Fulfilment detail.** Cancel/Reopen-cancelled, notes, due date, overdue flag, search, pagination and Refresh are missing.
5. **Fans row power tools.** QR, Copy DM, per-wheel passes with Open, Delete fan, campaign/pack fields on mint and top-up are missing. Without the mint campaign select, revenue silently becomes "untracked" (what `47896fb` fixed).
6. **Boosts.** The webhooks card (and its e2e), the happy-hour create form, leaderboard View/Copy links, and Save for link-in-bio are missing.
7. **Settings.** The brand-color card, personal note and live `/c/[slug]` preview are missing.
8. **Admin.** Access requests, role select, feature flags and the typed-email delete confirm are missing. The design also folds Admin into the creator shell, so the server role gate must move with it.
9. **Shell.** Agency invites banner, `/agency` link, demo-mode notice, "Get started" re-open, Today Snooze, inbox quick replies and failed-send retry are missing.

**Design items with no or partial backing (`new in design`):**
- Notification bell + dot: no feed API, no web push (spec #1).
- Top-bar search: no search endpoint.
- Pulse "Active fans this week": no metric. Trend chips and "today" values must be computed from `/api/metrics` daily series.
- Today impact tags: not in the autopilot payload. Derive them from `action.kind`.
- Workspace "handle", "Pro workspace" plan, live dot; Settings "Handle"; Admin row "plan": no fields exist.
- First-run "Share it in your bio" step: no signal. Use slug-set from `/api/public-profile`.
- Notification pref "low on stock": no backing pref (current prefs are newSpin/lowBalance/messages).
- Drawer "Message": InboxPanel can't preselect a thread yet.

**Contradictions and risks:**
- **README is wrong about `PendingClient.tsx`.** It is the `/pending` approval form, not fulfilment. Don't restyle it as fulfilment.
- **The prototype's logic is not the spec.** Its `drawWheel` (12px truncation, no flip, ignores label color/size), naive odds (ignores stock), equal-split Balance, `cycleRarity` without the ticket re-fill, flat +5 top-up, and `@` auto-prefix would each **reintroduce a fixed bug**. Port the markup, keep the current logic.
- **readableInk.** The README rule flips the default pink to dark ink. That updates `theme.test.ts` and every `.btn-brand`, and these hard-coded `text-white`/`#fff` brand fills must switch: `DC:311`, `DC:350`, `DC:355`, `DC:510`, `DC:756`, `DC:907`; `GSC:87`; `IP:282`, `IP:532`, `IP:548`; `WS:243`; `UI:89`. Phase 1 already exists on `origin/dashboard-redesign` @ `1c8a16a`, but its `.reveal` still uses opacity.
- **Toast 2.4s vs Undo.** Shortening the default cuts the prize-removal Undo window. Keep a longer duration for toasts with an action.
- **Mobile fixed layers.** The toast stack (`src/components/ui/Toast.tsx:66-72`, bottom), the debug launcher (`bottom-3 left-3`) and the new bottom tab bar all compete for the same space. Offset the toast and launcher above the bar.
- **Moving Link-in-bio from Settings to Boosts** reverses a deliberate move (`77b7887` #6). Confirm with the owner, and keep avatar/brand/preview together.
- **Admin inside the shell.** It needs the same server-side `profiles.role` check (AGENTS.md auth contract §1–5). Never gate on client state alone. The prototype shows the Admin nav item to everyone.
- **Switching wheels drops unsaved edits without a warning,** both today and in the design. Worth adding while the chips are being built.
- **Behavior-spec items already done:** #2 pack stacking, #4 debug gate, #5 onboarding sticky, #6 stock→odds, and much of #3 (live theming, instant library refresh). The port must not regress them. Only #1 (notifications/web push) is genuinely new work.
