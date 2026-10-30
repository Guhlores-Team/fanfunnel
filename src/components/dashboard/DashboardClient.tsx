"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { brandVars } from "@/lib/theme";
import { isStarterWheel } from "@/lib/games/wheel/sample";
import type { WheelConfig } from "@/lib/games/wheel/types";
import type { CreatorOverview } from "@/lib/data/types";
import { ToastProvider } from "@/components/ui/Toast";
import { useFetch } from "@/lib/hooks/useFetch";
import TodayPanel from "@/components/dashboard/TodayPanel";
import PrizesPanel from "@/components/dashboard/PrizesPanel";
import FansPanel from "@/components/dashboard/FansPanel";
import MetricsPanel from "@/components/dashboard/MetricsPanel";
import WheelEditor from "@/components/dashboard/WheelEditor";
import InvitesBanner from "@/components/dashboard/InvitesBanner";
import GetStartedChecklist from "@/components/dashboard/GetStartedChecklist";
import DiscardChangesDialog from "@/components/dashboard/DiscardChangesDialog";
import NotificationBell from "@/components/dashboard/NotificationBell";
import TermsPrompt from "@/components/dashboard/TermsPrompt";
import { resolveSection } from "@/components/dashboard/dashboardSection";
import { deliveryLeaveDecision, type DeliveryNavigationState } from "@/components/dashboard/deliveryNavigation";
import { CreatorDraftProvider, type CreatorDraftScope, type CreatorDraftState, type CreatorLeaveOptions } from "./CreatorDrafts";
import { creatorNavigationState, creatorScopeIncludes } from "./creatorNavigation";
import {
  Sidebar,
  SetupChecklistButton,
  TopBar,
  SECTION_META,
  accountInitials,
  type Tab,
} from "@/components/dashboard/DashboardShell";
import MobileTabBar from "@/components/dashboard/MobileTabBar";
import { prefersReducedMotion } from "@/lib/sound";
import { firstStepsAllDone, isFirstRun } from "@/components/dashboard/firstSteps";

// Code-split the tab-gated panels so the initial dashboard bundle doesn't
// carry every tab a creator may never open. (QrButton is split in FansPanel.)
const PanelFallback = () => <div className="skeleton mt-4 h-64 rounded-xl" />;
const CampaignsPanel = dynamic(() => import("@/components/dashboard/CampaignsPanel"), {
  loading: PanelFallback,
});
const InboxPanel = dynamic(() => import("@/components/dashboard/InboxPanel"), {
  loading: PanelFallback,
});
const BoostsPanel = dynamic(() => import("@/components/dashboard/BoostsPanel"), {
  loading: PanelFallback,
});
const AnalyticsPanel = dynamic(() => import("@/components/dashboard/AnalyticsPanel"), {
  loading: PanelFallback,
});
const SettingsPanel = dynamic(() => import("@/components/dashboard/SettingsPanel"), {
  loading: PanelFallback,
});
// Admin lives in the shell as "Account › Admin". It only renders behind the
// server-derived `isAdmin` gate below, and every /api/admin route re-checks.
const AdminClient = dynamic(() => import("@/components/admin/AdminClient"), {
  loading: PanelFallback,
});

// Shared overview, polled (12s) + refreshed on tab focus so metrics + the
// pending badge stay live. `setData` is exposed for optimistic account edits.
function useOverview() {
  const { data, loading, reload, setData } = useFetch<CreatorOverview>(
    "/api/overview",
    { pollMs: 12000 }
  );
  return { data, loading, refresh: reload, setData };
}

// A Sign out from the phone More sheet arrives detached (the sheet closed to
// make room for the unsaved-changes dialog), and only a connected form submits.
function submitSignOut(form: HTMLFormElement) {
  if (form.isConnected) return form.submit();
  const copy = form.cloneNode(true) as HTMLFormElement;
  copy.hidden = true;
  document.body.appendChild(copy);
  copy.submit();
}

interface DashboardLeaveRequest {
  action: () => void;
  what: string;
  consequence: string;
  scope?: CreatorDraftScope;
}

export default function DashboardClient({
  isAdmin,
  email,
  initialWheel,
  initialOnboardingDismissed = false,
  initialTab,
}: {
  /** Server-derived (dashboard/page.tsx): an active admin per is_admin(), or
   *  demo mode. The only input to the Admin section gate. */
  isAdmin: boolean;
  email: string | null;
  initialWheel: WheelConfig;
  initialOnboardingDismissed?: boolean;
  /** Deep link (`/dashboard?section=admin`, used by the /admin redirect). */
  initialTab?: Tab;
}) {
  // The Admin section exists only when the server said so (never client state).
  const adminVisible = isAdmin;
  const [tab, setTab] = useState<Tab>(
    initialTab && (initialTab !== "admin" || adminVisible) ? initialTab : "today"
  );
  const [wheel, setWheel] = useState<WheelConfig>(() => structuredClone(initialWheel));
  // Last saved/loaded wheel JSON. Lives beside `wheel` so "Unsaved changes"
  // (and the edits themselves) survive leaving the Wheels section and coming back.
  const [savedWheelJson, setSavedWheelJson] = useState(() => JSON.stringify(initialWheel));
  const wheelDirty = useMemo(() => JSON.stringify(wheel) !== savedWheelJson, [wheel, savedWheelJson]);
  // Only flags are lifted. Private delivery text/codes stay inside the prize
  // editor and never enter the wheel JSON or dashboard state.
  const [deliveryDirty, setDeliveryDirty] = useState(false);
  const [deliveryPending, setDeliveryPending] = useState(false);
  const deliveryState = useRef<DeliveryNavigationState>({ dirty: false, pending: false });
  const [creatorDrafts, setCreatorDrafts] = useState<ReadonlyMap<string, CreatorDraftState>>(() => new Map());
  const creatorDraftsRef = useRef<ReadonlyMap<string, CreatorDraftState>>(new Map());
  const [blockedScope, setBlockedScope] = useState<CreatorDraftScope | undefined>(undefined);
  const blockedScopeRef = useRef<CreatorDraftScope | undefined>(undefined);
  const [blockedDeliveryLeave, setBlockedDeliveryLeave] = useState(false);
  const [leaveRequest, setLeaveRequest] = useState<DashboardLeaveRequest | null>(null);
  const leaveRequestRef = useRef<DashboardLeaveRequest | null>(null);
  const registerCreatorDraft = useCallback((id: string, state: CreatorDraftState | null) => {
    const current = creatorDraftsRef.current;
    const old = current.get(id);
    if (!state || (!state.dirty && !state.pending)) {
      if (!old) return;
    } else if (old?.scope === state.scope && old.description === state.description && old.dirty === state.dirty && old.pending === state.pending) return;
    const next = new Map(current);
    if (state && (state.dirty || state.pending)) next.set(id, state);
    else next.delete(id);
    creatorDraftsRef.current = next;
    setCreatorDrafts(next);
    if (!creatorNavigationState(next, deliveryState.current, blockedScopeRef.current).pending) setBlockedDeliveryLeave(false);
  }, []);
  const deliveryDraftChanged = useCallback((dirty: boolean) => {
    deliveryState.current.dirty = dirty;
    setDeliveryDirty(dirty);
  }, []);
  const deliveryPendingChanged = useCallback((pending: boolean) => {
    deliveryState.current.pending = pending;
    setDeliveryPending(pending);
    if (!creatorNavigationState(creatorDraftsRef.current, deliveryState.current, blockedScopeRef.current).pending) setBlockedDeliveryLeave(false);
  }, []);
  const creatorNavigation = useMemo(() => creatorNavigationState(creatorDrafts, { dirty: deliveryDirty, pending: deliveryPending }), [creatorDrafts, deliveryDirty, deliveryPending]);
  const blockedNavigation = useMemo(() => creatorNavigationState(creatorDrafts, { dirty: deliveryDirty, pending: deliveryPending }, blockedScope), [creatorDrafts, deliveryDirty, deliveryPending, blockedScope]);
  // Leaving with unsaved wheel edits. Sign out asks in-app first (below); a
  // reload/close can only get the browser's own beforeunload prompt. Lives
  // here, not in the editor, so it holds while another section is open.
  const leavingRef = useRef(false);
  useEffect(() => {
    if (!wheelDirty && !creatorNavigation.dirty && !creatorNavigation.pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!leavingRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [wheelDirty, creatorNavigation.dirty, creatorNavigation.pending]);
  const requestLeave = useCallback((action: () => void, intent: "section" | "signout", options?: CreatorLeaveOptions) => {
    // A later push message must not replace a choice already being reviewed.
    if (leaveRequestRef.current) return;
    const state = creatorNavigationState(creatorDraftsRef.current, deliveryState.current, options?.scope);
    const decision = deliveryLeaveDecision(state, wheelDirty, intent);
    if (decision === "wait") {
      blockedScopeRef.current = options?.scope;
      setBlockedScope(options?.scope);
      setBlockedDeliveryLeave(true);
      return;
    }
    if (decision === "confirm") {
      const request: DashboardLeaveRequest = {
        action,
        what: [...(intent === "signout" && wheelDirty ? ["your wheel"] : []), ...state.descriptions].join(" and ") || "your changes",
        consequence: options?.consequence ?? (intent === "signout" ? "Signing out now throws them away." : "Changing sections throws away these unsaved form changes. Your wheel edits stay here."),
        scope: options?.scope,
      };
      leaveRequestRef.current = request;
      setLeaveRequest(request);
      return;
    }
    action();
  }, [wheelDirty]);
  const draftRegistry = useMemo(() => ({ register: registerCreatorDraft, leave: (action: () => void, options?: CreatorLeaveOptions) => requestLeave(action, "section", options) }), [registerCreatorDraft, requestLeave]);
  // Which wheel the editor is currently editing. Lifted so it survives tab
  // switches and the WheelSwitcher highlights the right wheel. Seeded from the
  // initial active wheel's id so the switcher highlights it on first paint.
  const [editingWheelId, setEditingWheelId] = useState<string | null>(
    initialWheel.id ?? null
  );
  const overview = useOverview();
  const pending = overview.data?.metrics.pending ?? 0;
  const unread = overview.data?.metrics.unreadMessages ?? 0;

  // First-run signals: a brand-new creator has no fans and no spins yet, and is
  // still on the sample wheel (no saved wheel id of their own).
  const metricsFans = overview.data?.metrics.fans ?? 0;
  const metricsSpins = overview.data?.metrics.spinsPlayed ?? 0;
  const metricsFulfilled = overview.data?.metrics.fulfilled ?? 0;
  // "Built a wheel" comes from the server (saved an edit, or has >1 wheel) so it
  // catches every edit and reliably survives reloads / new wheels. The local
  // content check is a fast pre-save hint so editing ticks the step instantly.
  const wheelBuilt = overview.data?.metrics.wheelBuilt ?? false;
  const wheelSaved = wheelBuilt || !isStarterWheel(wheel);

  // Get-started checklist dismissal, persisted to the account (not the browser).
  // Seeded from the server so it's correct on first paint and across devices.
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    initialOnboardingDismissed
  );
  const firstStepSignals = {
    wheelSaved,
    fans: metricsFans,
    spins: metricsSpins,
    fulfilled: metricsFulfilled,
  };
  const onboardingAllDone = firstStepsAllDone(firstStepSignals);
  const setOnboardingHidden = useCallback((hidden: boolean) => {
    setOnboardingDismissed(hidden);
    // Fire-and-forget: the UI already reflects the change optimistically.
    void fetch("/api/account/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed: hidden }),
    }).catch(() => {});
  }, []);

  // #13: make completion STICKY. Onboarding "all done" is inferred from live
  // metrics, so without this, deleting/archiving the wheel (or fans dropping to
  // zero) would make the checklist reappear. The first time every step is
  // genuinely complete, persist the dismissal to the account ONCE — after that
  // it stays hidden permanently regardless of later data changes.
  const persistedDoneRef = useRef(false);
  useEffect(() => {
    if (overview.loading) return;
    if (onboardingAllDone && !onboardingDismissed && !persistedDoneRef.current) {
      persistedDoneRef.current = true;
      setOnboardingHidden(true);
    }
  }, [overview.loading, onboardingAllDone, onboardingDismissed, setOnboardingHidden]);

  // Brand-new creators land on Today, where "Your first steps" guides them
  // (RD-5) — no auto-switch to the Wheel editor any more.
  const goTab = useCallback((t: Tab, after?: () => void) => {
    if (t === "admin" && !adminVisible) return;
    const navigate = () => {
      setTab(t);
      after?.();
    };
    // A plain re-select preserves the mounted editor. Actions such as search
    // can remount even the current section, so they still use the guard.
    if (t === tab && !after) navigate();
    else requestLeave(navigate, "section");
  }, [tab, adminVisible, requestLeave]);

  // Onboarding CTAs: switch to the relevant tab AND scroll its panel into view,
  // so a creator on a phone is actually taken to the section to act on it.
  const panelRef = useRef<HTMLDivElement>(null);
  const checklistRef = useRef<HTMLDivElement>(null);
  const goToSection = (t: Tab, after?: () => void) => {
    goTab(t, () => {
      after?.();
      requestAnimationFrame(() => {
        panelRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      });
    });
  };

  // "Edit game" / "Change game" shortcuts from Campaigns and the fan drawer.
  const [gameRequest, setGameRequest] = useState<{ id: string; nonce: number } | null>(null);
  const openGameEditor = (id: string) => goToSection("editor", () => setGameRequest((s) => ({ id, nonce: (s?.nonce ?? 0) + 1 })));
  const openCampaigns = () => goToSection("campaigns");

  // "Your first steps" lives inside Today (replacing the old every-section
  // checklist). Rendered here so its signals + dismissal stay owned by the
  // dashboard; TodayPanel only places it.
  const checklistVisible = !overview.loading && !onboardingDismissed && !onboardingAllDone;
  const firstSteps = checklistVisible ? (
    <div ref={checklistRef} className="scroll-mt-24">
      <GetStartedChecklist
        signals={firstStepSignals}
        dismissed={onboardingDismissed}
        onDismiss={() => setOnboardingHidden(true)}
        onGoTo={(t) => goToSection(t as Tab)}
      />
    </div>
  ) : null;

  // Display name for the sidebar workspace pill (no polling — it rarely changes).
  const account = useFetch<{ displayName: string | null }>(email ? "/api/account" : null);
  const accountName =
    account.data?.displayName?.trim() || (email ? email.split("@")[0] : "Demo creator");
  const accountSub = email ?? "Demo workspace — connect Supabase to go live";

  // Shared by the sidebar (desktop) and the More sheet (phone).
  const guardSignOut = (e: React.FormEvent, form: HTMLFormElement) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    requestLeave(() => {
      leavingRef.current = true;
      submitSignOut(form);
    }, "signout");
  };
  const onSignOut = (e: React.FormEvent<HTMLFormElement>) => guardSignOut(e, e.currentTarget);
  const setupOffered = !overview.loading && onboardingDismissed && !onboardingAllDone;
  const reopenSetup = () => {
    // The checklist lives on Today: open it there and bring it into view.
    goTab("today", () => {
      setOnboardingHidden(false);
      requestAnimationFrame(() => {
        checklistRef.current?.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "start",
        });
      });
    });
  };

  // Top-bar search routes the query to the Fans panel's existing name filter.
  // The nonce remounts FansPanel so a repeat search re-applies the query.
  const [fanSearch, setFanSearch] = useState({ q: "", nonce: 0 });
  // "New fan link" → Fans, focus the mint form's name field.
  const [mintFocus, setMintFocus] = useState(0);
  // Fan drawer "Message" → Inbox with that fan's thread selected. The nonce lets
  // the same fan be re-requested after the creator picked another thread.
  const [inboxFocus, setInboxFocus] = useState<{ fanId: string | null; nonce: number }>({
    fanId: null,
    nonce: 0,
  });
  // Web push opt-in (Settings › Notifications): the bell footer and the Inbox
  // open it; the nonce scrolls the card into view each time.
  const [pushFocus, setPushFocus] = useState(0);
  const openPushSettings = () => {
    goTab("settings", () => setPushFocus((n) => n + 1));
  };
  // A tapped push notification while a dashboard is open: the service worker
  // asks it to switch section in place (no reload, unsaved edits survive).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (d?.type !== "ff:navigate" || typeof d.url !== "string") return;
      let url: URL;
      try { url = new URL(d.url, window.location.origin); }
      catch { return; }
      if (url.origin !== window.location.origin || url.pathname !== "/dashboard") return;
      const section = resolveSection(url.searchParams.get("section") ?? undefined, adminVisible);
      if (section) goTab(section);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [adminVisible, goTab]);

  const [title, subtitleText] = SECTION_META[tab];
  // Phones show just the date on Today (the compressed top bar has no room).
  const subtitle =
    tab === "today" ? (
      <>
        {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        <span className="max-lg:hidden"> · {subtitleText}</span>
      </>
    ) : (
      subtitleText
    );

  return (
    <ToastProvider>
    <CreatorDraftProvider value={draftRegistry}>
    <div
      className="flex min-h-[100dvh] flex-col lg:flex-row"
      // Live brand theming: the page shell seeds --brand at request time, but
      // binding it to the editor's wheel state here means picking a new brand
      // color re-tints the whole dashboard instantly — no refresh needed.
      // brandVars also derives --brand-ink / --brand-text so text stays legible
      // on ANY brand color (#1).
      style={brandVars(wheel.brandColor)}
      onSubmitCapture={(event) => {
        // Covers every sign-out form, including the Terms prompt, while the
        // sidebar/phone handlers remain compatible with their existing API.
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const action = new URL(form.action, window.location.origin);
        if (action.origin === window.location.origin && action.pathname === "/auth/signout") guardSignOut(event, form);
      }}
    >
      <Sidebar
        active={tab}
        onSelect={goTab}
        badges={{ prizes: pending, inbox: unread }}
        // Server-derived gate: is_admin() via checkAdmin in dashboard/page.tsx
        // (or demo mode, decided there too). The /api/admin routes re-check.
        showAdmin={adminVisible}
        accountName={accountName}
        accountSub={accountSub}
        showSignOut={!!email}
        onSignOut={onSignOut}
        footerExtra={setupOffered ? <SetupChecklistButton onClick={reopenSetup} /> : null}
      />

      {/* Below `lg` the fixed bottom tab bar covers the last 60px (+ safe area,
          which body already pads), so the column reserves that space. */}
      <div className="flex min-w-0 flex-1 flex-col max-lg:pb-[60px]">
        <TopBar
          title={title}
          subtitle={subtitle}
          mobileLead={
            <span
              aria-hidden="true"
              className="grid h-10 w-10 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-sm font-bold text-ink"
            >
              {accountInitials(accountName)}
            </span>
          }
          onSearch={(q) => {
            goToSection("fans", () => setFanSearch((s) => ({ q, nonce: s.nonce + 1 })));
          }}
          onNewFanLink={() => {
            goTab("fans", () => setMintFocus((n) => n + 1));
          }}
          bell={
            <NotificationBell
              onOpenPushSettings={openPushSettings}
              // Same in-app routes as the drawer "Message" and top-bar search.
              onNavigate={({ section, fanId, fanName }) => {
                goToSection(section, () => {
                  if (section === "inbox" && fanId) setInboxFocus((s) => ({ fanId, nonce: s.nonce + 1 }));
                  if (section === "fans" && fanName) setFanSearch((s) => ({ q: fanName, nonce: s.nonce + 1 }));
                });
              }}
            />
          }
        />

        <div className="w-full max-w-[1140px] flex-1 px-4 py-6 sm:p-7">
      {email && <InvitesBanner />}

      <div
        ref={panelRef}
        className="scroll-mt-24"
        id={`panel-${tab}`}
        role="region"
        aria-label={title}
      >
        {tab === "today" && (
          <TodayPanel
            onNavigate={(t) => goTab(t as Tab)}
            overview={overview.data}
            firstSteps={firstSteps}
            firstRun={!overview.loading && isFirstRun(firstStepSignals)}
          />
        )}
        {tab === "prizes" && (
          <PrizesPanel
            data={overview.data}
            loading={overview.loading}
            refresh={overview.refresh}
            setData={overview.setData}
          />
        )}
        {tab === "fans" && (
          <FansPanel
            key={fanSearch.nonce}
            initialSearch={fanSearch.q}
            focusMintNonce={mintFocus}
            onMessage={(fanId) => {
              goToSection("inbox", () => setInboxFocus((s) => ({ fanId, nonce: s.nonce + 1 })));
            }}
            onOpenGame={openGameEditor}
            onOpenCampaigns={openCampaigns}
          />
        )}
        {tab === "campaigns" && <CampaignsPanel onOpenGame={openGameEditor} />}
        {tab === "boosts" && (
          <BoostsPanel
            leaderboardEnabled={overview.data?.metrics.leaderboardEnabled ?? false}
            onLeaderboardChange={overview.refresh}
            onNavigate={(t) => goTab(t as Tab)}
          />
        )}
        {tab === "inbox" && (
          <InboxPanel
            onChanged={overview.refresh}
            initialFanId={inboxFocus.fanId}
            initialFanNonce={inboxFocus.nonce}
            onOpenPushSettings={openPushSettings}
          />
        )}
        {tab === "analytics" && (
          /* One consolidated view: the Command Center's designed cards (stat
             strip, trends, what's landing, rarity mix) up top, then profit &
             prize costs, Audience (conversion, CRM, cohorts) and Timing
             (heatmap) below. MetricsPanel hands its polled funnel down. */
          <MetricsPanel
            overview={overview.data}
            loading={overview.loading}
            onGoTo={goTab}
            renderDeep={() => <AnalyticsPanel />}
          />
        )}
        {tab === "editor" && (
          <WheelEditor
            wheel={wheel}
            setWheel={setWheel}
            savedJson={savedWheelJson}
            setSavedJson={setSavedWheelJson}
            editingWheelId={editingWheelId}
            setEditingWheelId={setEditingWheelId}
            onWheelMutated={overview.refresh}
            onDeliveryDraftChange={deliveryDraftChanged}
            onDeliveryPendingChange={deliveryPendingChanged}
            openGameRequest={gameRequest}
            onOpenGameHandled={() => setGameRequest(null)}
            onOpenCampaigns={openCampaigns}
          />
        )}
        {tab === "settings" && (
          <SettingsPanel
            pushFocus={pushFocus}
            // Re-tint the whole dashboard the instant a new brand color is saved
            // in Settings (it persists to the active wheel; mirror it locally so
            // --brand updates with no refresh — #9).
            onBrandColorChange={(color) =>
              setWheel((w) => ({ ...w, brandColor: color }))
            }
            // …and the sidebar's workspace name the moment a new one is saved.
            onDisplayNameChange={(displayName) =>
              account.setData((d) => ({ ...d, displayName }))
            }
          />
        )}
        {tab === "admin" && adminVisible && <AdminClient />}
        {leaveRequest && (
          <DiscardChangesDialog
            what={leaveRequest.what}
            consequence={leaveRequest.consequence}
            onKeep={() => { leaveRequestRef.current = null; setLeaveRequest(null); }}
            onDiscard={() => {
              const next = leaveRequestRef.current;
              leaveRequestRef.current = null;
              setLeaveRequest(null);
              if (!next) return;
              if (creatorNavigationState(creatorDraftsRef.current, deliveryState.current, next.scope).pending) {
                blockedScopeRef.current = next.scope; setBlockedScope(next.scope); setBlockedDeliveryLeave(true); return;
              }
              const remaining = new Map([...creatorDraftsRef.current].filter(([, record]) => !creatorScopeIncludes(next.scope, record.scope)));
              creatorDraftsRef.current = remaining;
              setCreatorDrafts(remaining);
              if (next.scope === undefined) { deliveryState.current.dirty = false; setDeliveryDirty(false); }
              next?.action();
            }}
          />
        )}
        {blockedDeliveryLeave && blockedNavigation.pending && (
          <DiscardChangesDialog pending what="your changes" pendingTitle={blockedNavigation.pendingDescriptions.length === 1 && blockedNavigation.pendingDescriptions[0] === "prize delivery" ? undefined : "A request still needs checking"} pendingMessage={blockedNavigation.pendingDescriptions.length === 1 && blockedNavigation.pendingDescriptions[0] === "prize delivery" ? undefined : "Keep this page open while the request finishes. If its result is unconfirmed, use the form's Check again button before leaving. Then choose where to go next."} onKeep={() => setBlockedDeliveryLeave(false)} onDiscard={() => {}} />
        )}
      </div>
        </div>
      </div>

      <MobileTabBar
        active={tab}
        onSelect={goTab}
        badges={{ prizes: pending, inbox: unread }}
        // Same server-derived gate as the sidebar (never client state).
        showAdmin={adminVisible}
        accountName={accountName}
        accountSub={accountSub}
        initials={accountInitials(accountName)}
        showSignOut={!!email}
        onSignOut={onSignOut}
        onSetup={setupOffered ? reopenSetup : undefined}
      />
      <TermsPrompt canSignOut={!!email} />
    </div>
    </CreatorDraftProvider>
    </ToastProvider>
  );
}
