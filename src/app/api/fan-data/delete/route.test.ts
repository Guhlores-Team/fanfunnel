import assert from "node:assert";
import { mock } from "node:test";

// POST /api/fan-data/delete: deletes ONLY the fan behind the posted token,
// and only after the typed confirmation. Negative cases: no/incorrect confirm
// word, malformed token, rate limit → nothing is deleted. Answers are no-store.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const deletes: string[] = [];
let limited = false;

mock.module("@/lib/data", {
  namedExports: {
    isPlausibleToken: (t: unknown) => typeof t === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(t),
    deleteFanData: async (token: string) => {
      deletes.push(token);
      if (token === "demo") return { error: "not_allowed" };
      return token === "tokA1aaaaaaa" ? { ok: true, spinsKept: 4 } : { error: "not_found" };
    },
  },
});
mock.module("@/lib/api/limit", {
  namedExports: {
    rateLimitOr429: async () => (limited ? Response.json({ error: "rate_limited" }, { status: 429 }) : null),
  },
});

async function main() {
  const { POST } = await import("./route");
  const call = (body: unknown) =>
    POST(new Request("http://localhost/api/fan-data/delete", { method: "POST", body: JSON.stringify(body) }));

  for (const confirm of [undefined, "", "yes", "DELET", "delete it"]) {
    const res = await call({ token: "tokA1aaaaaaa", confirm });
    check(`confirm ${JSON.stringify(confirm)} → 400`, res.status === 400 && (await res.json()).error === "confirm_mismatch");
  }
  check("nothing deleted without the confirm word", deletes.length === 0);

  let res = await call({ token: "../x", confirm: "DELETE" });
  check("malformed token → 400, nothing deleted", res.status === 400 && deletes.length === 0);

  res = await call({ token: "tokA1aaaaaaa", confirm: " delete " });
  const body = await res.json();
  check("own token + confirm → 200 with spins kept", res.status === 200 && body.ok === true && body.spinsKept === 4);
  check("no-store", /no-store/.test(res.headers.get("cache-control") ?? ""));
  check("deleted exactly the posted token's fan", deletes.length === 1 && deletes[0] === "tokA1aaaaaaa");

  res = await call({ token: "tokZZZZZZZZZ", confirm: "DELETE" });
  check("unknown token → 404", res.status === 404);
  res = await call({ token: "demo", confirm: "DELETE" });
  check("demo fan → 403 not_allowed", res.status === 403 && (await res.json()).error === "not_allowed");

  deletes.length = 0;
  limited = true;
  res = await call({ token: "tokA1aaaaaaa", confirm: "DELETE" });
  check("rate limited → 429, nothing deleted", res.status === 429 && deletes.length === 0);

  console.log(`fan-data delete route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
