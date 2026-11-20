/**
 * WF-05: a PAGE request that is rate-limited must get a page, not raw JSON.
 * Built without React so the proxy (Node runtime, no app tree) can send it.
 * Inline styles only: the public CSP allows them and no script is needed.
 * Every value interpolated is a number this code computed.
 */
export function tooManyRequestsPage(retryAfterSeconds: number): string {
  const secs = Math.max(1, Math.min(3600, Math.ceil(retryAfterSeconds) || 1));
  const wait = secs >= 120 ? `${Math.ceil(secs / 60)} minutes` : `${secs} seconds`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Too many requests · FanFunnel</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 24px; background: #0c0a0e; color: #f5f3f7; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 24rem; border-radius: 1.5rem; padding: 2rem; background: #161219; box-shadow: 0 0 0 1px rgba(255,255,255,.08); text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
  p { margin: .5rem 0; color: #c9c3d1; }
  .wait { font-weight: 700; color: #f5f3f7; }
  a { color: #f5f3f7; }
</style>
</head>
<body>
<main>
  <p aria-hidden="true" style="font-size:2rem;margin:0">⏳</p>
  <h1>Too many requests</h1>
  <p>This page is being asked for faster than we can show it from your connection.</p>
  <p>Try again in <span class="wait">${wait}</span>. Nothing was spent.</p>
  <p style="font-size:12px;margin-top:1.5rem">Powered by FanFunnel</p>
</main>
</body>
</html>
`;
}
