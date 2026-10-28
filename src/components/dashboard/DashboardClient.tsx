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
  // Leaving with unsaved wheel edits. Sign out asks in-app first (below); a
  // reload/close can only get the browser's own beforeunload prompt. Lives
  // here, not in the editor, so it holds while another section is open.
  const leavingRef = useRef(false);
  const [signOutForm, setSignOutForm] = useState<HTMLFormElement | null>(null);
  useEffect(() => {
    if (!wheelDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!leavingRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [wheelDirty]);
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
  const goTab = (t: Tab) => setTab(t);

  // Onboarding CTAs: switch to the relevant tab AND scroll its panel into view,
  // so a creator on a phone is actually taken to the section to act on it.
  const panelRef = useRef<HTMLDivElement>(null);
  const checklistRef = useRef<HTMLDivElement>(null);
  const goToSection = (t: Tab) => {
    goTab(t);
    requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    });
  };

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
  const onSignOut = (e: React.FormEvent<HTMLFormElement>) => {
    if (!wheelDirty) return;
    e.preventDefault();
    setSignOutForm(e.currentTarget);
  };
  const setupOffered = !overview.loading && onboardingDismissed && !onboardingAllDone;
  const reopenSetup = () => {
    setOnboardingHidden(false);
    // The checklist lives on Today: open it there and bring it into view.
    goTab("today");
    requestAnimationFrame(() => {
      checklistRef.current?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
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
    goTab("settings");
    setPushFocus((n) => n + 1);
  };
  // A tapped push notification while a dashboard is open: the service worker
  // asks it to switch section in place (no reload, unsaved edits survive).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (d?.type !== "ff:navigate" || typeof d.url !== "string") return;
      const section = resolveSection(new URL(d.url, window.location.origin).searchParams.get("section") ?? undefined, adminVisible);
      if (section) setTab(section);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [adminVisible]);

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
    <div
      className="flex min-h-[100dvh] flex-col lg:flex-row"
      // Live brand theming: the page shell seeds --brand at request time, but
      // binding it to the editor's wheel state here means picking a new brand
      // color re-tints the whole dashboard instantly — no refresh needed.
      // brandVars also derives --brand-ink / --brand-text so text stays legible
      // on ANY brand color (#1).
      style={brandVars(wheel.brandColor)}
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
            setFanSearch((s) => ({ q, nonce: s.nonce + 1 }));
            goToSection("fans");
          }}
          onNewFanLink={() => {
            goTab("fans");
            setMintFocus((n) => n + 1);
          }}
          bell={
            <NotificationBell
              onOpenPushSettings={openPushSettings}
              // Same in-app routes as the drawer "Message" and top-bar search.
              onNavigate={({ section, fanId, fanName }) => {
                if (section === "inbox" && fanId) setInboxFocus((s) => ({ fanId, nonce: s.nonce + 1 }));
                if (section === "fans" && fanName) setFanSearch((s) => ({ q: fanName, nonce: s.nonce + 1 }));
                goToSection(section);
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
            onNavigate={(t) => setTab(t as Tab)}
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
              setInboxFocus((s) => ({ fanId, nonce: s.nonce + 1 }));
              goToSection("inbox");
            }}
          />
        )}
        {tab === "campaigns" && <CampaignsPanel />}
        {tab === "boosts" && (
          <BoostsPanel
            leaderboardEnabled={overview.data?.metrics.leaderboardEnabled ?? false}
            onLeaderboardChange={overview.refresh}
            onNavigate={(t) => setTab(t as Tab)}
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
            onGoTo={setTab}
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
        {signOutForm && (
          <DiscardChangesDialog
            what="your wheel"
            consequence="Signing out now throws them away."
            onKeep={() => setSignOutForm(null)}
            onDiscard={() => {
              leavingRef.current = true;
              submitSignOut(signOutForm);
            }}
          />
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
    </ToastProvider>
  );
}
