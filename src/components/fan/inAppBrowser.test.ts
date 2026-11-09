import assert from "node:assert/strict";
import { androidBrowserIntent, detectInAppBrowser } from "./inAppBrowser";
import { fanDataNeedsInline } from "./FanDataControls";

let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }

// Real user-agent strings (as the apps send them), FD-5/6/7.
const IN_APP: [string, string, { ios?: boolean; android?: boolean }][] = [
  ["instagram", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 307.0.0.34.111 (iPhone14,5; iOS 17_1; en_US; en; scale=3.00; 1170x2532; 532277068)", { ios: true }],
  ["instagram", "Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36 Instagram 309.0.0.40.113 Android", { android: true }],
  ["facebook", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone13,2;FBMD/iPhone;FBSN/iOS;FBSV/16.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]", { ios: true }],
  ["facebook", "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SQ3A.220705.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.71 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/375.0.0.24.112;]", { android: true }],
  ["messenger", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/398.0.0.29.106;FBBV/450573353]", { ios: true }],
  ["tiktok", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_31.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US", { ios: true }],
  ["tiktok", "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 trill_310503 BytedanceWebview/d8a21c6", { android: true }],
  ["x", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.20", { ios: true }],
  ["x", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 TwitterAndroid", { android: true }],
  ["telegram", "Mozilla/5.0 (Linux; Android 13; SM-A536B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36 Telegram-Android/10.2.6 (Samsung SM-A536B; Android 13; SDK 33; HIGH)", { android: true }],
  ["snapchat", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.62.0.37 (like Safari/8617.2.4.10.8, panda)", { ios: true }],
  ["line", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.17.0", { ios: true }],
  ["wechat", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002831) NetType/WIFI Language/en", { ios: true }],
  ["linkedin", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.6402", { ios: true }],
  // A cam site's or any other app's embedded browser that doesn't name itself.
  ["webview", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", { ios: true }],
  ["webview", "Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36", { android: true }],
];
for (const [app, ua, where] of IN_APP) {
  const found = detectInAppBrowser(ua);
  check(`${app} is detected: ${ua.slice(0, 60)}`, found?.app === app);
  check(`${app} platform`, found?.ios === !!where.ios && found?.android === !!where.android);
}

// Real browsers are never told to leave.
const BROWSERS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "",
];
for (const ua of BROWSERS) check(`a real browser is not an in-app browser: ${ua.slice(0, 60) || "(empty)"}`, detectInAppBrowser(ua) === null);
check("null user agent", detectInAppBrowser(null) === null && detectInAppBrowser(undefined) === null);

// Android: open the same page in Chrome, keeping path and query, with a web fallback.
const intent = androidBrowserIntent("https://fanfunnel.app/spin/abc-123?x=1");
check("intent keeps host, path and query", intent?.startsWith("intent://fanfunnel.app/spin/abc-123?x=1#Intent;scheme=https;") === true);
check("intent falls back to the same address", intent?.includes("S.browser_fallback_url=" + encodeURIComponent("https://fanfunnel.app/spin/abc-123?x=1")) === true);
check("non-web addresses get no intent", androidBrowserIntent("javascript:alert(1)") === null && androidBrowserIntent("not a url") === null);

// FD-7: where the export is shown instead of downloaded.
check("Instagram shows the export on the page", fanDataNeedsInline(IN_APP[0][1], true));
check("a browser without the download attribute shows it on the page", fanDataNeedsInline(BROWSERS[0], false));
check("Safari downloads the file", !fanDataNeedsInline(BROWSERS[0], true));

console.log(`inAppBrowser: ${passed} checks passed`);
