// FanFunnel app service worker (RM-4 foundation; web push adds its handlers here).
//
// Registered ONLY from the creator dashboard, with scope "/dashboard". Fan
// pages (/spin/<token>) have no service worker at all.
//
// Deliberately NO "fetch" handler and NO Cache Storage: nothing this worker
// controls is ever cached or served by it, so a signed-in dashboard page or an
// API response can never outlive a sign-out on a shared device. Web push may
// add "push" and "notificationclick" handlers only. src/lib/pwa/sw.test.ts
// fails the build if a fetch handler or the Cache API appears here.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
