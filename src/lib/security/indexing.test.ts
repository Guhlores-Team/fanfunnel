import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

// SUP-9 / SUP-13: crawlers may index only a Production deployment, and only its
// marketing and creator pages; no response advertises the framework.

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// Minimal robots.txt matcher (longest match wins, Allow wins a tie), enough to
// read the policy the way a crawler does.
function allowed(txt: string, agent: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  for (const raw of txt.split("\n")) {
    const [key, ...rest] = raw.split(":");
    const value = rest.join(":").trim();
    const k = key.trim().toLowerCase();
    if (k === "user-agent") {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if ((k === "allow" || k === "disallow") && current) current.rules.push({ allow: k === "allow", path: value });
  }
  const group = groups.find((g) => g.agents.includes(agent.toLowerCase())) ?? groups.find((g) => g.agents.includes("*"));
  let best: { allow: boolean; path: string } | null = null;
  for (const rule of group?.rules ?? []) {
    if (!rule.path || !path.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

async function main() {
  const { robotsPolicy, indexingHeaders, isProductionDeployment } = await import("./indexing");
  const { resolveRobots } = (await import("next/dist/build/webpack/loaders/metadata/resolve-route-data.js")) as unknown as {
    resolveRobots: (data: unknown) => string;
  };
  const { default: robots } = await import("../../app/robots");

  check("only VERCEL_ENV=production counts as Production", isProductionDeployment("production") && ![undefined, "", "preview", "development", "Production"].some((e) => isProductionDeployment(e)));

  // --- Non-production: nothing is crawlable --------------------------------
  for (const env of [undefined, "preview", "development", ""]) {
    const txt = resolveRobots(robotsPolicy(env));
    for (const path of ["/", "/c/demo", "/privacy", "/share/abc", "/leaderboard/x", "/spin/t"]) {
      for (const agent of ["Googlebot", "Twitterbot"]) check(`${env ?? "unset"}: ${agent} may not crawl ${path}`, !allowed(txt, agent, path));
    }
    check(`${env ?? "unset"}: X-Robots-Tag noindex on every response`, JSON.stringify(indexingHeaders(env)) === JSON.stringify([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]));
  }

  // --- Production: marketing + creator pages only -------------------------
  const prod = resolveRobots(robotsPolicy("production"));
  check("production sends no X-Robots-Tag", indexingHeaders("production").length === 0);
  for (const path of ["/", "/c/demo-creator", "/privacy", "/terms"]) {
    check(`production: search engines may crawl ${path}`, allowed(prod, "Googlebot", path) && allowed(prod, "Bingbot", path));
  }
  for (const path of ["/spin/secret-token", "/share/abc", "/share/abc/opengraph-image", "/verify/abc", "/leaderboard/creator-1",
    "/api/spin", "/dashboard", "/dashboard/settings", "/admin", "/agency", "/pending", "/mfa", "/login", "/auth/callback", "/reset-password", "/forgot-password"]) {
    check(`production: search engines may not crawl ${path}`, !allowed(prod, "Googlebot", path) && !allowed(prod, "SomeNewBot", path));
  }
  // Shared links still unfurl: link-preview bots may fetch a share card.
  for (const agent of ["Twitterbot", "facebookexternalhit", "LinkedInBot", "Slackbot-LinkExpanding", "Discordbot"]) {
    check(`production: ${agent} may fetch /share/<id> and its card`, allowed(prod, agent, "/share/abc") && allowed(prod, agent, "/share/abc/opengraph-image"));
    check(`production: ${agent} still may not crawl fan or signed-in paths`, ["/spin/t", "/verify/abc", "/leaderboard/x", "/dashboard", "/api/spin"].every((p) => !allowed(prod, agent, p)));
  }

  // --- The app route serves the policy for this build's VERCEL_ENV --------
  const before = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  const beforeSite = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://fanfunnel.example";
  const prodWithSitemap = resolveRobots(robotsPolicy("production", "https://fanfunnel.example"));
  check("robots.ts serves the Production policy on Production, with the sitemap on the site's own address", resolveRobots(robots()) === prodWithSitemap && /Sitemap: https:\/\/fanfunnel\.example\/sitemap\.xml/.test(prodWithSitemap));
  check("the sitemap line changes nothing a crawler may fetch", ["/", "/terms", "/spin/t", "/dashboard"].every((p) => allowed(prodWithSitemap, "Googlebot", p) === allowed(prod, "Googlebot", p)));
  const { default: sitemap } = await import("../../app/sitemap");
  const urls = sitemap().map((e) => e.url).sort();
  check("the Production sitemap lists the home page, Terms and Privacy on the site's own address, and nothing private", JSON.stringify(urls) === JSON.stringify(["https://fanfunnel.example", "https://fanfunnel.example/privacy", "https://fanfunnel.example/terms"]));
  process.env.VERCEL_ENV = "preview";
  check("a Preview sitemap is empty", sitemap().length === 0);
  process.env.VERCEL_ENV = "production";
  if (beforeSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = beforeSite;
  process.env.VERCEL_ENV = "preview";
  check("robots.ts disallows everything on a Preview", !allowed(resolveRobots(robots()), "Googlebot", "/"));
  if (before === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = before;

  // --- next.config.ts ships the header and drops X-Powered-By --------------
  // next.config.ts reads VERCEL_ENV once at load, so each environment loads it
  // in its own process.
  const probe = `
    const { AsyncLocalStorage } = await import("node:async_hooks");
    globalThis.AsyncLocalStorage = AsyncLocalStorage;
    const { unstable_getResponseFromNextConfig } = await import("next/experimental/testing/server");
    const loaded = await import(${JSON.stringify(join(process.cwd(), "next.config.ts"))});
    // tsx loads the .ts config as CommonJS from here: unwrap the interop default.
    const nextConfig = loaded.default?.default ?? loaded.default;
    const out = { poweredByHeader: nextConfig.poweredByHeader, robots: {} };
    for (const path of ["/", "/c/demo", "/spin/t", "/share/abc", "/api/spin", "/dashboard", "/sw.js"]) {
      const res = await unstable_getResponseFromNextConfig({ url: "https://fanfunnel.test" + path, nextConfig });
      out.robots[path] = res.headers.get("x-robots-tag");
    }
    console.log(JSON.stringify(out));
  `;
  for (const env of ["preview", "production", ""]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
      encoding: "utf8",
      env: { ...process.env, VERCEL_ENV: env },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { poweredByHeader: unknown; robots: Record<string, string | null> };
    check(`next.config (${env || "unset"}): poweredByHeader is false`, out.poweredByHeader === false);
    for (const [path, value] of Object.entries(out.robots)) {
      check(`next.config (${env || "unset"}): ${path} X-Robots-Tag`, env === "production" ? value === null : value === "noindex, nofollow");
    }
  }

  console.log(`indexing: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
