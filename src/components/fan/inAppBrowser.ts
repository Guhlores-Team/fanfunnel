// FD-5/6/7: an app's built-in browser (Instagram, TikTok, X…) has no site
// settings, no "Add to Home Screen" and often no file downloads, so the fan is
// told to open the link in their phone's browser instead. Pure, so it is
// unit-tested against real user-agent strings.

export type InAppApp =
  | "instagram" | "facebook" | "messenger" | "tiktok" | "x" | "telegram" | "snapchat"
  | "line" | "wechat" | "linkedin" | "pinterest" | "reddit" | "discord" | "webview";

export interface InAppBrowser {
  /** Which app, or "webview" for an unnamed app's embedded browser. */
  app: InAppApp;
  ios: boolean;
  android: boolean;
}

// Most specific first: Messenger's UA also carries FBAN.
const APPS: [InAppApp, RegExp][] = [
  ["instagram", /\bInstagram\b/i],
  ["messenger", /\bFBAN\/Messenger|\bMessengerForiOS|\bMessengerLite|\bOrca-Android/i],
  ["facebook", /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b|\bFB4A\b/],
  ["tiktok", /\bmusical_ly|\bBytedanceWebview|\bBytedance\b|\bTikTok\b|\btrill_/i],
  ["x", /\bTwitter(?:Android)?\b|\bTwitter for iP/i],
  ["telegram", /\bTelegram\b|\bTelegram-Android\b/i],
  ["snapchat", /\bSnapchat\b/i],
  ["line", /\bLine\/\d/],
  ["wechat", /\bMicroMessenger\//i],
  ["linkedin", /\bLinkedInApp\b/i],
  ["pinterest", /\bPinterest\//i],
  ["reddit", /\bReddit\//i],
  ["discord", /\bDiscord\//i],
];

/**
 * The in-app browser this user agent belongs to, or null for a real browser
 * (Safari, Chrome, Firefox, Samsung Internet, Edge…). Beyond the named apps,
 * an iPhone/iPad page without the "Safari/" token is a WKWebView inside some
 * app, and Android's WebView marks itself with "; wv)": that covers the apps
 * (cam sites included) that don't name themselves.
 */
export function detectInAppBrowser(userAgent: string | null | undefined): InAppBrowser | null {
  const ua = userAgent ?? "";
  if (!ua) return null;
  const ios = /\b(iPhone|iPad|iPod)\b/.test(ua);
  const android = /\bAndroid\b/.test(ua);
  for (const [app, re] of APPS) if (re.test(ua)) return { app, ios, android };
  if (ios && /AppleWebKit/.test(ua) && !/\bSafari\//.test(ua)) return { app: "webview", ios, android };
  if (android && /;\s*wv\)/.test(ua)) return { app: "webview", ios, android };
  return null;
}

/** This page's in-app browser, read in the browser only (null on the server). */
export function currentInAppBrowser(): InAppBrowser | null {
  return typeof navigator === "undefined" ? null : detectInAppBrowser(navigator.userAgent);
}

/** Android: an intent link that opens the same page in Chrome (or the default browser). */
export function androidBrowserIntent(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.slice(0, -1)};action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
  } catch { return null; }
}
