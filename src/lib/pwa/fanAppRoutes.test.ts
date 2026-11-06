/**
 * RM-4 route-level tests (demo data layer, no Supabase):
 *   GET /spin/<token>/manifest           per-link web app manifest
 *   GET /spin/<token>/icon/<variant>     home-screen PNGs
 *   GET /app-icon/<variant>              the dashboard app's PNGs (no token)
 *
 * The token is a bearer credential: every token response must be private (no
 * shared/CDN cache), noindex, and an unknown, malformed or paused link is a
 * plain 404 that is not cacheable either. Lives here (not under [token]/)
 * because the test runner refuses paths with brackets.
 */
import assert from "node:assert";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

/** Width/height from a PNG's IHDR chunk. */
function pngSize(buf: ArrayBuffer): { w: number; h: number } | null {
  const b = new Uint8Array(buf);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null;
  const dv = new DataView(buf);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

function noPublicCache(res: Response, what: string) {
  const cc = res.headers.get("cache-control") ?? "";
  check(`${what}: Cache-Control is private (${cc})`, /^private\b/.test(cc));
  check(`${what}: no s-maxage / public`, !/s-maxage|public|immutable/i.test(cc));
  check(`${what}: X-Robots-Tag noindex`, /noindex/.test(res.headers.get("x-robots-tag") ?? ""));
}

async function main() {
  const { GET: manifestGET } = await import("@/app/spin/[token]/manifest/route");
  const { GET: iconGET } = await import("@/app/spin/[token]/icon/[variant]/route");
  const { GET: appIconGET } = await import("@/app/app-icon/[variant]/route");
  const mock = await import("@/lib/data/mock");
  const { selfExclude } = await import("@/lib/data");

  const req = (path: string) => new Request("http://localhost" + path);
  const manifest = (token: string) =>
    manifestGET(req(`/spin/${token}/manifest`), { params: Promise.resolve({ token }) });
  const icon = (token: string, variant: string) =>
    iconGET(req(`/spin/${token}/icon/${variant}`), { params: Promise.resolve({ token, variant }) });

  // --- manifest for a live link ------------------------------------------------
  {
    const res = await manifest("demo");
    check("manifest: 200 for a live link", res.status === 200);
    check("manifest: application/manifest+json", res.headers.get("content-type") === "application/manifest+json");
    noPublicCache(res, "manifest");
    const m = await res.json();
    check("manifest: start_url bound to the token", m.start_url === "/spin/demo?src=pwa");
    check("manifest: scope bound to the token", m.scope === "/spin/demo");
    check("manifest: neutral by default (D8)", m.name === "Spins");
    check("manifest: neutral has no creator name", !JSON.stringify(m).includes("Demo Creator"));
    check("manifest: theme colour is the wheel's brand", /^#[0-9a-f]{6}$/i.test(m.theme_color));
  }

  // --- the creator flips to avatar: the name follows --------------------------
  {
    mock.mockSetMyPwaIconMode("avatar");
    const m = await (await manifest("demo")).json();
    check("manifest: avatar mode uses the creator's name", m.name === "Demo Creator");
    mock.mockSetMyPwaIconMode("neutral");
    const back = await (await manifest("demo")).json();
    check("manifest: back to neutral", back.name === "Spins");
  }

  // --- icons ---------------------------------------------------------------------
  for (const [variant, size] of [["192", 192], ["512", 512], ["maskable-512", 512], ["180", 180]] as const) {
    const res = await icon("demo", variant);
    check(`icon ${variant}: 200`, res.status === 200);
    check(`icon ${variant}: image/png`, res.headers.get("content-type") === "image/png");
    noPublicCache(res, `icon ${variant}`);
    const dim = pngSize(await res.arrayBuffer());
    check(`icon ${variant}: a ${size}x${size} PNG (got ${JSON.stringify(dim)})`, dim?.w === size && dim?.h === size);
  }
  {
    const res = await icon("demo", "1024");
    check("icon: unknown variant → 404", res.status === 404);
  }

  // --- dashboard app icons (no token: may be cached publicly) ----------------
  {
    const res = await appIconGET(req("/app-icon/192"), { params: Promise.resolve({ variant: "192" }) });
    check("app icon: 200 PNG", res.status === 200 && res.headers.get("content-type") === "image/png");
    check("app icon: 192x192", pngSize(await res.arrayBuffer())?.w === 192);
  }

  // --- unknown / malformed / paused links: a bare, uncacheable 404 -------------
  for (const token of ["no-such-token", "a.b", "x".repeat(200)]) {
    const res = await manifest(token);
    check(`manifest ${token.slice(0, 16)}: 404`, res.status === 404);
    check(`manifest ${token.slice(0, 16)}: 404 is not cacheable`, /no-store/.test(res.headers.get("cache-control") ?? ""));
    const body = await res.text();
    check(`manifest ${token.slice(0, 16)}: 404 says nothing about the link`, body === JSON.stringify({ error: "not_found" }));
    const ires = await icon(token, "192");
    check(`icon ${token.slice(0, 16)}: 404`, ires.status === 404);
  }
  {
    const r = await selfExclude("demo");
    check("pause the demo link (setup)", "ok" in r);
    check("paused link: manifest 404", (await manifest("demo")).status === 404);
    check("paused link: icon 404", (await icon("demo", "192")).status === 404);
  }

  console.log(`pwa fan app routes: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
