"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { useLinkPause } from "./LinkPauseProvider";
import { installNudgeSnoozed, isIosDevice, snoozeInstallNudge } from "./installNudge";

/** Chrome's install event (not in the DOM lib types). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const STANDALONE_QUERY = "(display-mode: standalone)";

function subscribeStandalone(onChange: () => void) {
  const mq = window.matchMedia(STANDALONE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function isStandalone(): boolean {
  return (
    window.matchMedia(STANDALONE_QUERY).matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
const noSubscribe = () => () => {};
const iosSnapshot = () => isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
const serverFalse = () => false;

/** The installed app's name, from the page's own apple-mobile-web-app-title. */
function appName(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  return meta?.content.trim() || "this page";
}

/**
 * RM-4: after a fan's first win of the session, offer to add their link to the
 * home screen. Android/Chrome gets a real Install button (beforeinstallprompt);
 * iPhone/iPad Safari gets a two-step "How" guide. Never shown before a win (so
 * never before the age gate), when already installed, on a paused link, or for
 * 14 days after "Not now". It is a card in the flow, never a wall.
 * Mounted with one line from SpinClient: `armed` is "a win is on screen".
 */
export default function InstallNudge({ armed }: { armed: boolean }) {
  const { paused } = useLinkPause();
  const standalone = useSyncExternalStore(subscribeStandalone, isStandalone, serverFalse);
  const ios = useSyncExternalStore(noSubscribe, iosSnapshot, serverFalse);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [shown, setShown] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [name, setName] = useState("this page");
  const titleId = useId();
  const guideId = useId();

  // Chrome fires this once it considers the page installable. Keep the event so
  // the prompt opens from OUR button after a win, not as an unprompted banner.
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Latch on the first win: the card stays (below the wheel) after the prize
  // modal closes, until installed or dismissed.
  const eligible = !standalone && !paused && (deferred !== null || ios);
  if (armed && eligible && !shown && !hidden) {
    if (installNudgeSnoozed()) setHidden(true);
    else {
      setShown(true);
      setName(appName());
    }
  }

  if (!shown || hidden || !eligible) return null;

  const dismiss = () => {
    snoozeInstallNudge();
    setHidden(true);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({ outcome: "dismissed" as const }));
    setDeferred(null);
    if (outcome === "accepted") setHidden(true);
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="install-nudge"
      className="lift-in w-full rounded-2xl border p-4 text-left"
      style={{
        borderColor: "color-mix(in oklab, var(--brand) 40%, transparent)",
        background: "color-mix(in oklab, var(--brand) 8%, var(--color-surface))",
      }}
    >
      <h2 id={titleId} className="text-sm font-extrabold text-ink">
        Add {name} to your home screen <span aria-hidden="true">⭐</span>
      </h2>
      <p className="mt-1 text-sm text-muted text-pretty">
        Open your wheel in one tap, like an app.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {deferred ? (
          <button
            type="button"
            onClick={install}
            className="btn-brand inline-flex min-h-11 items-center justify-center rounded-xl px-5 text-sm font-extrabold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
          >
            Install
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setGuideOpen((o) => !o)}
            aria-expanded={guideOpen}
            aria-controls={guideId}
            className="btn-brand inline-flex min-h-11 items-center justify-center rounded-xl px-5 text-sm font-extrabold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
          >
            How
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line px-4 text-sm font-semibold text-ink transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        >
          Not now
        </button>
      </div>
      {!deferred && guideOpen && (
        <ol id={guideId} className="mt-3 space-y-2 text-sm text-ink">
          <li className="flex items-center gap-3">
            <StepBadge n={1} />
            <span className="min-w-0">
              Tap <ShareGlyph /> <span className="font-semibold">Share</span> in Safari&rsquo;s toolbar.
            </span>
          </li>
          <li className="flex items-center gap-3">
            <StepBadge n={2} />
            <span className="min-w-0">
              Choose <PlusGlyph /> <span className="font-semibold">Add to Home Screen</span>, then Add.
            </span>
          </li>
        </ol>
      )}
    </section>
  );
}

function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-extrabold"
      style={{ background: "var(--brand)", color: "var(--brand-ink)" }}
    >
      {n}
    </span>
  );
}

const glyph = "inline-block h-[1.1em] w-[1.1em] align-[-0.2em]";

/** iOS's Share icon: a box with an arrow out of the top. */
function ShareGlyph() {
  return (
    <svg className={glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1" />
    </svg>
  );
}

/** iOS's "Add to Home Screen" icon: a plus in a rounded square. */
function PlusGlyph() {
  return (
    <svg className={glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}
