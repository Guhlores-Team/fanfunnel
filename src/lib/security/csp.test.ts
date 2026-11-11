import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// L3: the Content-Security-Policy every response carries. Pins the directives
// of both policies (src/lib/security/csp.ts), that next.config.ts ships the
// public one on every route, and that the proxy replaces it with a fresh
// nonce policy on the signed-in pages and forwards the nonce to Next.

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

function parse(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    assert.ok(!out.has(name), `directive ${name} appears once`);
    out.set(name, sources);
  }
  return out;
}

const SB = "https://abcdefghijklmnop.supabase.co";

async function main() {
  const { buildCsp, createNonce, supabaseOrigins, STRICT_CSP_PAGES } = await import("./csp");
  const { getScriptNonceFromHeader } = await import(
    "next/dist/server/app-render/get-script-nonce-from-header"
  );

  // --- Directives shared by both policies ----------------------------------
  const nonce = createNonce();
  const strict = parse(buildCsp({ mode: "strict", nonce, supabaseUrl: `${SB}/rest/v1/` }));
  const pub = parse(buildCsp({ mode: "public", supabaseUrl: SB }));
  for (const [label, p] of [["strict", strict], ["public", pub]] as const) {
    const eq = (name: string, want: string[]) =>
      check(`${label}: ${name} is ${want.join(" ")}`, JSON.stringify(p.get(name)) === JSON.stringify(want));
    eq("default-src", ["'self'"]);
    eq("style-src", ["'self'", "'unsafe-inline'"]);
    eq("img-src", ["'self'", "data:", "blob:", SB]);
    eq("font-src", ["'self'"]);
    eq("connect-src", ["'self'", SB, "wss://abcdefghijklmnop.supabase.co"]);
    eq("worker-src", ["'self'"]);
    eq("manifest-src", ["'self'"]);
    eq("frame-src", ["'none'"]);
    eq("object-src", ["'none'"]);
    eq("base-uri", ["'self'"]);
    eq("form-action", ["'self'"]);
    eq("frame-ancestors", ["'self'"]);
    const all = [...p.values()].flat();
    check(`${label}: no wildcard or scheme-wide source`, !all.some((s) => s === "*" || /^(https?|wss?):$/.test(s) || s.includes("*")));
    check(`${label}: no eval in production`, !all.includes("'unsafe-eval'") && !all.includes("'wasm-unsafe-eval'"));
    check(`${label}: no style nonce (it would switch off 'unsafe-inline' for style attributes)`, !p.get("style-src")!.some((s) => s.startsWith("'nonce-")));
    check(`${label}: data:/blob: never allowed for scripts`, !p.get("script-src")!.some((s) => s === "data:" || s === "blob:"));
  }

  // --- script-src ----------------------------------------------------------
  check("strict script-src is self + nonce + strict-dynamic", JSON.stringify(strict.get("script-src")) === JSON.stringify(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]));
  check("strict has no 'unsafe-inline'", !strict.get("script-src")!.includes("'unsafe-inline'"));
  check("public script-src is self + unsafe-inline only", JSON.stringify(pub.get("script-src")) === JSON.stringify(["'self'", "'unsafe-inline'"]));
  check("Next extracts exactly our nonce from the strict header", getScriptNonceFromHeader(buildCsp({ mode: "strict", nonce })) === nonce);
  check("Next finds no nonce in the public header", getScriptNonceFromHeader(buildCsp({ mode: "public" })) === undefined);
  check("strict refuses a missing nonce", (() => { try { buildCsp({ mode: "strict" }); return false; } catch { return true; } })());
  check("strict refuses a nonce that could break out of the directive", (() => { try { buildCsp({ mode: "strict", nonce: "a' 'unsafe-inline" }); return false; } catch { return true; } })());

  // Dev only: React's dev build needs eval. Nothing else changes.
  const dev = parse(buildCsp({ mode: "strict", nonce, dev: true }));
  check("dev adds 'unsafe-eval' to script-src", dev.get("script-src")!.includes("'unsafe-eval'"));
  check("dev changes nothing else", JSON.stringify([...dev.entries()].filter(([k]) => k !== "script-src")) === JSON.stringify([...parse(buildCsp({ mode: "strict", nonce })).entries()].filter(([k]) => k !== "script-src")));

  // --- Nonces --------------------------------------------------------------
  const nonces = new Set(Array.from({ length: 200 }, () => createNonce()));
  check("nonces are unique per call", nonces.size === 200);
  check("nonces are 128-bit base64", [...nonces].every((n) => /^[A-Za-z0-9+/]{22}==$/.test(n) && Buffer.from(n, "base64").length === 16));

  // --- Supabase origin handling --------------------------------------------
  check("demo mode (no Supabase URL) adds no origin", supabaseOrigins(undefined) === null && supabaseOrigins("") === null);
  check("a path on the URL is reduced to the origin", supabaseOrigins(`${SB}/rest/v1/`)?.http === SB);
  check("local http Supabase gets ws:", supabaseOrigins("http://127.0.0.1:54321")?.ws === "ws://127.0.0.1:54321");
  check("non-http URLs are ignored", supabaseOrigins("javascript:alert(1)") === null && supabaseOrigins("not a url") === null);
  const demo = parse(buildCsp({ mode: "public" }));
  check("demo connect-src is self only", JSON.stringify(demo.get("connect-src")) === JSON.stringify(["'self'"]));

  // --- next.config.ts ships the public policy everywhere -------------------
  const { unstable_getResponseFromNextConfig } = await import("next/experimental/testing/server");
  const { default: nextConfig } = await import("../../../next.config");
  const shipped = buildCsp({ mode: "public", supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL });
  for (const path of ["/", "/c/demo", "/spin/some-token", "/share/abc", "/privacy", "/reset-password", "/dashboard", "/api/spin"]) {
    const res = await unstable_getResponseFromNextConfig({ url: `https://fanfunnel.test${path}`, nextConfig });
    const csp = res.headers.get("content-security-policy") ?? "";
    check(`${path} carries the public CSP`, csp.split(", ").includes(shipped));
    check(`${path} has Cross-Origin-Opener-Policy: same-origin`, res.headers.get("cross-origin-opener-policy") === "same-origin");
    check(`${path} keeps X-Frame-Options`, res.headers.get("x-frame-options") === "SAMEORIGIN");
    const corp = res.headers.get("cross-origin-resource-policy");
    check(`${path} CORP only on the API`, path.startsWith("/api/") ? corp === "same-origin" : corp === null);
  }

  const sw = await unstable_getResponseFromNextConfig({ url: "https://fanfunnel.test/sw.js", nextConfig });
  check("/sw.js keeps its own same-origin worker policy", sw.headers.get("content-security-policy") === "default-src 'self'; script-src 'self'");

  // --- The proxy swaps in a fresh nonce policy on the signed-in pages -------
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../../proxy");
  const { needsSessionRefresh } = await import("../supabase/middleware");
  const event = { waitUntil() {} } as unknown as Parameters<typeof proxy>[1];
  const seen = new Set<string>();
  for (const path of ["/dashboard", "/admin", "/agency", "/pending", "/login", "/mfa", "/auth/confirm", "/dashboard"]) {
    const res = await proxy(new NextRequest(`https://fanfunnel.test${path}`), event);
    const header = res.headers.get("content-security-policy") ?? "";
    const n = getScriptNonceFromHeader(header);
    check(`${path}: response carries a nonce policy`, !!n && header === buildCsp({ mode: "strict", nonce: n!, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL }));
    check(`${path}: the same policy is forwarded to Next's renderer`, res.headers.get("x-middleware-request-content-security-policy") === header);
    seen.add(n!);
  }
  check("every request gets its own nonce", seen.size === 8);
  // Valid percent paths on public routes, and unknown paths under the proxied
  // ones: those are answered by prerendered HTML (its scripts have no nonce).
  for (const path of ["/c/caf%C3%A9", "/spin/a%20b", "/dashboard/settings", "/admin/x", "/signup", "/dashboard%20x"]) {
    const res = await proxy(new NextRequest(`https://fanfunnel.test${path}`), event);
    check(`${path}: not given a nonce policy`, !res.headers.get("content-security-policy") && !res.headers.get("x-middleware-request-content-security-policy"));
  }

  // A nonce policy on a prerendered page would block its scripts (they carry
  // no nonce), so no page under a proxied path may opt into static output.
  const pages: { path: string; file: string }[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry === "page.tsx") pages.push({ path: "/" + relative(join("src", "app"), dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s)).join("/"), file: p });
    }
  })(join("src", "app"));
  const strictPages = pages.filter(({ path }) => needsSessionRefresh(path));
  check("found the signed-in pages", strictPages.length >= 6);
  check(
    "the strict list is exactly the pages the proxy runs on",
    JSON.stringify(strictPages.map((p) => p.path).sort()) === JSON.stringify([...STRICT_CSP_PAGES].sort())
  );
  for (const { path, file } of strictPages) {
    const src = readFileSync(file, "utf8");
    check(`${path} never opts into static output`, !/export\s+const\s+(revalidate|dynamic\s*=\s*["']force-static)|generateStaticParams/.test(src));
  }

  // --- Violations reach monitoring, without URLs or extension noise ----------
  const { describeCspViolation } = await import("../monitoring/client");
  check("inline script violation is described by keyword", describeCspViolation({ effectiveDirective: "script-src-elem", blockedURI: "inline" }) === "CSP blocked script-src-elem: inline");
  check("a blocked URL is reduced to its origin (no path/token)", describeCspViolation({ effectiveDirective: "connect-src", blockedURI: "https://x.supabase.co/rest/v1/fans?token=SECRET" }) === "CSP blocked connect-src: https://x.supabase.co");
  check("a websocket keeps only its origin", describeCspViolation({ effectiveDirective: "connect-src", blockedURI: "wss://x.supabase.co/realtime/v1/websocket?apikey=SECRET" }) === "CSP blocked connect-src: wss://x.supabase.co");
  check("data: URIs report only the scheme", describeCspViolation({ effectiveDirective: "img-src", blockedURI: "data:image/png;base64,SECRET" }) === "CSP blocked img-src: data");
  check("extension-injected content is not reported", describeCspViolation({ effectiveDirective: "script-src-elem", blockedURI: "chrome-extension://abc/x.js" }) === null && describeCspViolation({ effectiveDirective: "script-src-elem", blockedURI: "inline", sourceFile: "moz-extension://abc/c.js" }) === null);
  check("directive text is sanitized", describeCspViolation({ effectiveDirective: "script-src<img>", blockedURI: "eval" }) === "CSP blocked script-srcimg: eval");

  // The policy module stays out of client bundles' way: no secrets, no imports.
  const mod = readFileSync(join("src", "lib", "security", "csp.ts"), "utf8");
  check("csp.ts imports nothing (next.config.ts loads it)", !/^\s*import\s/m.test(mod));

  console.log(`security/csp: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
