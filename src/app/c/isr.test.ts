import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PERF-4: /c/[slug] (the public link-in-bio page) is ISR, not per-request.
// That's only safe while nothing on it depends on the viewer, so this pins
// both the route config and the "no per-viewer input" precondition.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const page = readFileSync(join("src", "app", "c", "[slug]", "page.tsx"), "utf8");

check("no force-dynamic / dynamic override", !/export\s+const\s+dynamic\s*=/.test(page));
const revalidate = page.match(/export\s+const\s+revalidate\s*=\s*(\d+)\s*;/);
check("exports a numeric revalidate", !!revalidate);
const seconds = Number(revalidate?.[1]);
check("revalidate is between 1s and 5 minutes", seconds > 0 && seconds <= 300);
check(
  "generateStaticParams returns [] (required for runtime ISR of unknown slugs)",
  /export\s+(async\s+)?function\s+generateStaticParams\(\)\s*\{\s*return\s*\[\];?\s*\}/.test(page)
);

// Nothing per-viewer: no request APIs, no session client, no searchParams.
check("page doesn't read cookies/headers", !/next\/headers|cookies\(|headers\(/.test(page));
check("page doesn't use the session client", !/supabase\/server|createClient/.test(page));
check("page doesn't take searchParams", !/searchParams/.test(page));

// Its one data source reads with the service client, not the viewer's session.
const data = readFileSync(join("src", "lib", "data", "index.ts"), "latin1");
const start = data.indexOf("export async function getPublicProfileBySlug(");
check("found getPublicProfileBySlug", start >= 0);
const end = data.indexOf("\nexport ", start + 1);
const body = data.slice(start, end);
check("getPublicProfileBySlug uses the service client", body.includes("createServiceClient()"));
check("getPublicProfileBySlug never touches the session", !/await createClient\(\)|auth\.get(User|Session)/.test(body));

console.log(`c/[slug] ISR: ${passed} checks passed`);
