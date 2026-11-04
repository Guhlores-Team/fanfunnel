import { BASE, goto } from "./harness.mjs";

// L3: Content-Security-Policy on the running server. The headers carry the
// right policy per route, the signed-in pages' scripts all carry this
// request's nonce, and the browser really refuses injected script and eval.
// The probes run in their own page (no error sink): a refused injection is a
// console error by design. Every other journey runs with the sink attached,
// so any CSP violation the app itself causes fails the run as a browser signal.

const directive = (csp, name) =>
  (csp.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name) ?? []).slice(1);

export async function cspJourney(_page, { step, assert }, ctx) {
  await step("csp: signed-in pages get a fresh nonce policy that every script carries", async () => {
    const nonces = new Set();
    for (const path of ["/dashboard", "/dashboard", "/login"]) {
      const res = await ctx.request.get(BASE + path, { maxRedirects: 0 });
      assert(res.status() === 200 || res.status() === 307, `${path} answers (${res.status()})`);
      const csp = res.headers()["content-security-policy"] ?? "";
      const script = directive(csp, "script-src");
      const nonce = script.map((s) => /^'nonce-([A-Za-z0-9+/=]+)'$/.exec(s)?.[1]).find(Boolean);
      assert(nonce && script.includes("'strict-dynamic'"), `${path} script-src is nonce + strict-dynamic: ${script.join(" ")}`);
      assert(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"), `${path} allows neither inline script nor eval`);
      assert(!csp.includes(", "), `${path} sends one policy, not the public one as well`);
      nonces.add(nonce);
      if (res.status() !== 200) continue;
      const html = await res.text();
      const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      assert(tags.length > 0, `${path} renders scripts`);
      const bare = tags.filter((t) => !t.includes(`nonce="${nonce}"`));
      assert(bare.length === 0, `${path}: every script tag carries this response's nonce (${bare.length} without: ${bare[0] ?? ""})`);
    }
    assert(nonces.size === 3, "each response gets its own nonce");
  });

  await step("csp: public and API routes get the static policy and isolation headers", async () => {
    for (const path of ["/", "/privacy", "/spin/csp-no-such-link", "/dashboard/csp-no-such-page", "/api/me"]) {
      const res = await ctx.request.get(BASE + path);
      const h = res.headers();
      const script = directive(h["content-security-policy"] ?? "", "script-src");
      assert(script.join(" ") === "'self' 'unsafe-inline'", `${path} script-src is self + inline only: ${script.join(" ")}`);
      assert(directive(h["content-security-policy"], "object-src").join(" ") === "'none'", `${path} blocks plugins`);
      assert(directive(h["content-security-policy"], "frame-ancestors").join(" ") === "'self'", `${path} cannot be framed by another site`);
      assert(h["cross-origin-opener-policy"] === "same-origin", `${path} isolates its browsing context group`);
      assert((h["cross-origin-resource-policy"] ?? null) === (path.startsWith("/api/") ? "same-origin" : null), `${path} CORP only on the API`);
    }
  });

  await step("csp: the browser refuses injected script, inline handlers and eval", async () => {
    const probe = await ctx.newPage();
    try {
      const run = (external) => probe.evaluate(async (externalUrl) => {
        const seen = [];
        document.addEventListener("securitypolicyviolation", (e) => seen.push(e.effectiveDirective));
        window.__cspProbe = 0;
        const s = document.createElement("script");
        s.textContent = "window.__cspProbe = 1";
        document.body.appendChild(s);
        document.body.insertAdjacentHTML("beforeend", '<img alt="" src="data:," onerror="window.__cspProbe = 2">');
        let evalBlocked = false;
        try { (0, eval)("1"); } catch (e) { evalBlocked = e instanceof EvalError; }
        let externalBlocked = null;
        if (externalUrl) {
          externalBlocked = await new Promise((resolve) => {
            const x = document.createElement("script");
            x.setAttribute("src", externalUrl);
            x.onload = () => resolve(false);
            x.onerror = () => resolve(true);
            document.head.appendChild(x);
          });
        }
        await new Promise((r) => setTimeout(r, 300));
        return { ran: window.__cspProbe, evalBlocked, externalBlocked, seen };
      }, external);

      await goto(probe, "/dashboard", 800);
      const signedIn = await run(null);
      assert(signedIn.ran === 0, `/dashboard: injected inline script and handler did not run (${signedIn.ran})`);
      assert(signedIn.evalBlocked, "/dashboard: eval is refused");
      assert(signedIn.seen.includes("script-src-elem") && signedIn.seen.includes("script-src-attr"), `/dashboard: violations reported (${signedIn.seen.join(",")})`);

      await goto(probe, "/", 800);
      const pub = await run("http://127.0.0.1:9/csp-probe.js");
      assert(pub.evalBlocked, "/: eval is refused");
      assert(pub.externalBlocked === true && pub.seen.includes("script-src-elem"), `/: a script from another origin is refused (${pub.seen.join(",")})`);

      // The browser's violation reports reach monitoring, origin only.
      let rows = [];
      const deadline = Date.now() + 5000;
      do {
        const res = await ctx.request.get(BASE + "/api/admin/errors?status=open");
        assert(res.ok(), "demo admin can read recorded errors");
        rows = (await res.json()).errors.filter((row) => String(row.message).startsWith("CSP blocked "));
        if (rows.some((r) => r.message === "CSP blocked script-src-attr: inline") && rows.some((r) => r.message === "CSP blocked script-src-elem: http://127.0.0.1:9")) break;
        await new Promise((r) => setTimeout(r, 100));
      } while (Date.now() < deadline);
      const messages = rows.map((r) => r.message);
      assert(messages.includes("CSP blocked script-src-attr: inline") && messages.includes("CSP blocked script-src-elem: http://127.0.0.1:9"), `violations are reported to monitoring (${messages.join(" | ")})`);
      assert(!JSON.stringify(rows).includes("csp-probe.js"), "a blocked URL is reported by origin only");
    } finally {
      await probe.close();
    }
  });
}
