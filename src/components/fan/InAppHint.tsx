"use client";

import { useSyncExternalStore } from "react";
import { androidBrowserIntent, currentInAppBrowser, type InAppBrowser } from "./inAppBrowser";

// WF-07: inside an app's built-in browser (Instagram, TikTok, Facebook, a
// bare webview) nothing breaks, but "Add to home screen" and file downloads
// quietly differ, so the page says where it is and offers the phone's own
// browser before anything fails. One line; the storage-failure path keeps its
// fuller OpenInBrowser card.
const APP_NAME: Record<InAppBrowser["app"], string> = {
  instagram: "Instagram", facebook: "Facebook", messenger: "Messenger", tiktok: "TikTok", x: "X",
  telegram: "Telegram", snapchat: "Snapchat", line: "LINE", wechat: "WeChat", linkedin: "LinkedIn",
  pinterest: "Pinterest", reddit: "Reddit", discord: "Discord", webview: "an app",
};

// The user agent never changes while the page is open: one detection, read
// through useSyncExternalStore so the server render (null) and the first
// client render agree and the hint appears after hydration.
let detected: InAppBrowser | null | undefined;
const noSubscribe = () => () => {};
const snapshot = () => (detected === undefined ? (detected = currentInAppBrowser()) : detected);
const serverSnapshot = () => null;

export default function InAppHint() {
  const inApp = useSyncExternalStore(noSubscribe, snapshot, serverSnapshot);
  if (!inApp) return null;
  const href = window.location.href;
  const browser = inApp.ios ? "Safari" : inApp.android ? "Chrome" : "your browser";
  const intent = inApp.android && href ? androidBrowserIntent(href) : null;
  const inside = inApp.app === "webview" ? "an app's browser" : `${APP_NAME[inApp.app]}'s browser`;
  return (
    <p data-testid="in-app-hint" data-app={inApp.app} className="w-full text-center text-xs text-muted text-pretty">
      You&rsquo;re in {inside}.{" "}
      {intent ? (
        <a href={intent} className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4">
          Open in {browser} for the full experience
        </a>
      ) : (
        <span className="text-ink">Open this link in {browser} for the full experience (saving to your home screen and downloads).</span>
      )}
    </p>
  );
}
