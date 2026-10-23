"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  Sidebar,
  SetupChecklistButton,
  TopBar,
  SECTION_META,
  type Tab,
} from "@/components/dashboard/DashboardShell";
import { prefersReducedMotion } from "@/lib/sound";

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

// Shared overview, polled (12s) + refreshed on tab focus so metrics + the
// pending badge stay live. `setData` is exposed for optimistic account edits.
function useOverview() {
  const { data, loading, reload, setData } = useFetch<CreatorOverview>(
    "/api/overview",
    { pollMs: 12000 }
  );
  return { data, loading, refresh: reload, setData };
}

export default function DashboardClient({
  isAdmin,
  email,
  initialWheel,
  initialOnboardingDismissed = false,
}: {
  isAdmin: boolean;
  email: string | null;
  initialWheel: WheelConfig;
  initialOnboardingDismissed?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("today");
  const [wheel, setWheel] = useState<WheelConfig>(() => structuredClone(initialWheel));
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
  const onboardingAllDone = wheelSaved && metricsFans > 0 && metricsSpins > 0;
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

  // New creators should land on the Wheel editor (their first task), not the
  // empty "Today" feed. Switch once, on first data load, only if they haven't
  // already navigated somewhere themselves.
  const userPickedTab = useRef(false);
  const autoLanded = useRef(false);
  useEffect(() => {
    if (autoLanded.current || overview.loading || userPickedTab.current) return;
    autoLanded.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time landing choice after async overview load
    if (metricsFans === 0 && metricsSpins === 0) setTab("editor");
  }, [overview.loading, metricsFans, metricsSpins]);

  const goTab = (t: Tab) => {
    userPickedTab.current = true;
    setTab(t);
  };

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

  // Display name for the sidebar workspace pill (no polling — it rarely changes).
  const account = useFetch<{ displayName: string | null }>(email ? "/api/account" : null);
  const accountName =
    account.data?.displayName?.trim() || (email ? email.split("@")[0] : "Demo creator");

  // Top-bar search routes the query to the Fans panel's existing name filter.
  // The nonce remounts FansPanel so a repeat search re-applies the query.
  const [fanSearch, setFanSearch] = useState({ q: "", nonce: 0 });
  // "New fan link" → Fans, focus the mint form's name field.
  const [mintFocus, setMintFocus] = useState(0);

  const [title, subtitleText] = SECTION_META[tab];
  const subtitle =
    tab === "today"
      ? `${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${subtitleText}`
      : subtitleText;

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
        // Same gate as before the redesign: isAdmin comes from profiles.role on
        // the server (dashboard/page.tsx); no email = demo mode.
        showAdmin={isAdmin || !email}
        accountName={accountName}
        accountSub={email ?? "Demo workspace — connect Supabase to go live"}
        showSignOut={!!email}
        footerExtra={
          !overview.loading && onboardingDismissed && !onboardingAllDone ? (
            <SetupChecklistButton
              onClick={() => {
                setOnboardingHidden(false);
                // The checklist renders above the panel, so bring it (not the panel) into view.
                requestAnimationFrame(() => {
                  checklistRef.current?.scrollIntoView({
                    behavior: prefersReducedMotion() ? "auto" : "smooth",
                    block: "start",
                  });
                });
              }}
            />
          ) : null
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={title}
          subtitle={subtitle}
          onSearch={(q) => {
            setFanSearch((s) => ({ q, nonce: s.nonce + 1 }));
            goToSection("fans");
          }}
          onNewFanLink={() => {
            goTab("fans");
            setMintFocus((n) => n + 1);
          }}
        />

        <div className="w-full max-w-[1140px] flex-1 px-4 py-6 sm:p-7">
      {email && <InvitesBanner />}

      <div ref={checklistRef} className="scroll-mt-24">
      {!overview.loading && (
        <GetStartedChecklist
          wheelSaved={wheelSaved}
          fans={metricsFans}
          spins={metricsSpins}
          dismissed={onboardingDismissed}
          onDismiss={() => setOnboardingHidden(true)}
          onGoTo={(t) => goToSection(t as Tab)}
        />
      )}
      </div>

      <div
        ref={panelRef}
        className="scroll-mt-24"
        id={`panel-${tab}`}
        role="region"
        aria-label={title}
      >
        {tab === "today" && (
          <TodayPanel onNavigate={(t) => setTab(t as Tab)} overview={overview.data} />
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
          />
        )}
        {tab === "campaigns" && <CampaignsPanel />}
        {tab === "boosts" && (
          <BoostsPanel
            leaderboardEnabled={overview.data?.metrics.leaderboardEnabled ?? false}
            onLeaderboardChange={overview.refresh}
          />
        )}
        {tab === "inbox" && <InboxPanel onChanged={overview.refresh} />}
        {tab === "analytics" && (
          /* One consolidated view: live performance (pulse, trends, funnel,
             prize mix) up top, strategic insights (CRM, heatmap, profit,
             cohorts) below — was two separate Metrics/Analytics tabs. */
          <div className="space-y-10">
            <MetricsPanel
              overview={overview.data}
              loading={overview.loading}
              onGoTo={setTab}
            />
            <AnalyticsPanel />
          </div>
        )}
        {tab === "editor" && (
          <WheelEditor
            wheel={wheel}
            setWheel={setWheel}
            initialWheel={initialWheel}
            editingWheelId={editingWheelId}
            setEditingWheelId={setEditingWheelId}
            onWheelMutated={overview.refresh}
          />
        )}
        {tab === "settings" && (
          <SettingsPanel
            // Re-tint the whole dashboard the instant a new brand color is saved
            // in Settings (it persists to the active wheel; mirror it locally so
            // --brand updates with no refresh — #9).
            onBrandColorChange={(color) =>
              setWheel((w) => ({ ...w, brandColor: color }))
            }
          />
        )}
      </div>
        </div>
      </div>
    </div>
    </ToastProvider>
  );
}
