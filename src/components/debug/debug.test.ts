import assert from "node:assert";

// Behavior spec #4: the in-app debug console is gated behind `?debug=1` AND the
// admin role — never always-on. (The launcher is also only mounted when
// NEXT_PUBLIC_ENABLE_DEBUG=1, see src/app/layout.tsx.) Locks the gate in.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

function makeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

const win = {
  location: { search: "" },
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
};
(globalThis as { window?: unknown }).window = win;

async function main() {
  const { isDebugActive, resolveDebug, setDebugAdmin, reportError, getErrors, clearErrors } = await import("./debug");
  const report = () => reportError({ kind: "error", message: "boom" });

  check("no ?debug=1, not admin → off", !isDebugActive());

  win.location.search = "?debug=1";
  check("?debug=1 is requested", resolveDebug());
  check("?debug=1 alone (not admin) → still off", !isDebugActive());
  report();
  check("errors are not captured for a non-admin", getErrors().length === 0);

  setDebugAdmin(true);
  check("?debug=1 + admin → on", isDebugActive());
  report();
  check("errors are captured once active", getErrors().length === 1);

  win.location.search = "?debug=0";
  check("?debug=0 turns it off even for an admin", !isDebugActive());
  win.location.search = "";
  check("…and it stays off for the session", !isDebugActive());

  win.location.search = "?debug=1";
  check("re-enabled for an admin", isDebugActive());
  setDebugAdmin(false);
  check("losing admin turns it off", !isDebugActive());

  // The flag is session-scoped, never the old sticky localStorage key.
  win.localStorage.setItem("ff:debug", "1");
  win.location.search = "";
  win.sessionStorage.removeItem("ff:debug");
  setDebugAdmin(true);
  check("a legacy localStorage flag does not turn it on", !isDebugActive());
  check("the legacy key is purged", win.localStorage.getItem("ff:debug") === null);

  // Captured text never keeps a fan's spin-link token or a query string.
  win.location.search = "?debug=1";
  clearErrors();
  const TOKEN = "fan_tok_9f8e7d6c5b4a";
  reportError({
    kind: "error",
    message: `Failed to fetch https://fanfunnel.vercel.app/spin/${TOKEN}?ref=abc`,
    source: `https://fanfunnel.vercel.app/spin/${TOKEN}`,
    stack: `Error: x\n    at load (/api/messages/fan?token=${TOKEN}:1:2)\n    at /spin/${TOKEN}#top`,
  });
  const [captured] = getErrors();
  const all = [captured.message, captured.source, captured.stack].join("\n");
  check("the spin token is gone from message, source and stack", !all.includes(TOKEN));
  check("the spin path is kept, redacted", captured.source === "https://fanfunnel.vercel.app/spin/[redacted]");
  check("query strings are dropped", captured.message.endsWith("/spin/[redacted]?[redacted]"));
  check("a bare token= param is redacted", captured.stack!.includes("token=[redacted]"));
  check("the rest of the stack survives", captured.stack!.includes("at load (") && captured.stack!.includes("#top"));

  console.log(`debug gate: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
