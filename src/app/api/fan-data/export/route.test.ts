import assert from "node:assert";
import { mock } from "node:test";

// POST /api/fan-data/export: the fan token is the only credential. Negative
// cases: a malformed token never reaches the data layer; an unknown token 404s;
// the per-token and per-IP limits apply and the token itself never becomes a
// limiter key. Every answer is no-store; the export is a download.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const exportsAsked: string[] = [];
const limiterKeys: string[] = [];
let limitedKey: RegExp | null = null;

mock.module("@/lib/data", {
  namedExports: {
    isPlausibleToken: (t: unknown) => typeof t === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(t),
    exportFanData: async (token: string) => {
      exportsAsked.push(token);
      return token === "tokA1aaaaaaa" ? { format: "fanfunnel.fan-data.v1", profile: { displayName: "A" } } : null;
    },
  },
});
mock.module("@/lib/api/limit", {
  namedExports: {
    rateLimitOr429: async (key: string) => {
      limiterKeys.push(key);
      return limitedKey?.test(key) ? Response.json({ error: "rate_limited" }, { status: 429 }) : null;
    },
  },
});

async function main() {
  const { POST } = await import("./route");
  const call = (body: unknown) =>
    POST(new Request("http://localhost/api/fan-data/export", { method: "POST", body: JSON.stringify(body) }));

  let res = await call({ token: "tokA1aaaaaaa" });
  check("own token → 200", res.status === 200);
  check("is a download", /attachment; filename="fanfunnel-my-data-\d{4}-\d{2}-\d{2}\.json"/.test(res.headers.get("content-disposition") ?? ""));
  check("no-store", /no-store/.test(res.headers.get("cache-control") ?? ""));
  check("JSON body", (await res.json()).format === "fanfunnel.fan-data.v1");
  check("the raw token is never a limiter key", limiterKeys.every((k) => !k.includes("tokA1aaaaaaa")));
  check("limited per IP and per token", limiterKeys.some((k) => k.startsWith("fanexport:ip:")) && limiterKeys.some((k) => /^fanexport:[0-9a-f]{32}$/.test(k)));

  res = await call({ token: "tokZZZZZZZZZ" });
  check("unknown token → 404 no-store", res.status === 404 && /no-store/.test(res.headers.get("cache-control") ?? ""));

  exportsAsked.length = 0;
  for (const bad of [{}, { token: 42 }, { token: "../../x" }, { token: "a".repeat(500) }]) {
    res = await call(bad);
    check(`malformed ${JSON.stringify(bad).slice(0, 30)} → 400`, res.status === 400);
  }
  res = await POST(new Request("http://localhost/api/fan-data/export", { method: "POST", body: "not json" }));
  check("non-JSON body → 400", res.status === 400);
  check("malformed input never reached the data layer", exportsAsked.length === 0);

  limitedKey = /^fanexport:[0-9a-f]{32}$/;
  res = await call({ token: "tokA1aaaaaaa" });
  check("over the per-token limit → 429, no export", res.status === 429 && exportsAsked.length === 0);
  limitedKey = /^fanexport:ip:/;
  res = await call({ token: "tokA1aaaaaaa" });
  check("over the per-IP limit → 429, no export", res.status === 429 && exportsAsked.length === 0);

  console.log(`fan-data export route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
