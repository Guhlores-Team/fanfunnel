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

// --- Web push (closed-tab notifications for creators) -------------------------
//
// The server sends { title, body, url, tag } (src/lib/push/payload.ts). By
// default it is generic ("New activity on FanFunnel"); fan and prize names are
// only present when the creator turned on "Show names and prizes" for this
// device. The tag replaces an older notification for the same thread in place.

const DEFAULT_TITLE = "New activity on FanFunnel";
const HOME = "/dashboard";

function dashboardPath(url) {
  // Only same-origin dashboard paths: a payload can never open another site.
  try {
    const u = new URL(url, self.location.origin);
    if (u.origin === self.location.origin && (u.pathname === HOME || u.pathname.indexOf(HOME + "/") === 0)) {
      return u.pathname + u.search;
    }
  } catch {
    /* malformed: fall through */
  }
  return HOME;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 120) : DEFAULT_TITLE;
  const options = {
    body: typeof data.body === "string" ? data.body.slice(0, 200) : "",
    icon: "/app-icon/192",
    badge: "/app-icon/192",
    data: { url: dashboardPath(typeof data.url === "string" ? data.url : HOME) },
  };
  if (typeof data.tag === "string" && data.tag) {
    options.tag = data.tag.slice(0, 120);
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = dashboardPath((event.notification.data && event.notification.data.url) || HOME);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (new URL(c.url).pathname.indexOf(HOME) === 0 && "focus" in c) {
          // An open dashboard switches section in place (no reload, so unsaved
          // wheel edits survive).
          c.postMessage({ type: "ff:navigate", url: target });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
