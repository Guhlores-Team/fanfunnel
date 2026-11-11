import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
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
// The data layer is split by domain under src/lib/data; find the one module
// that declares the function rather than pinning its file name.
const DATA = join("src", "lib", "data");
const owners = readdirSync(DATA)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .filter((f) => readFileSync(join(DATA, f), "utf8").includes("export async function getPublicProfileBySlug("));
check("exactly one data module declares getPublicProfileBySlug", owners.length === 1);
const data = readFileSync(join(DATA, owners[0]), "utf8");
const start = data.indexOf("export async function getPublicProfileBySlug(");
check("found getPublicProfileBySlug", start >= 0);
const endIdx = data.indexOf("\nexport ", start + 1);
const end = endIdx === -1 ? data.length : endIdx;
const body = data.slice(start, end);
check(
  "@/lib/data still exports getPublicProfileBySlug for the page",
  /\bgetPublicProfileBySlug\b/.test(readFileSync(join(DATA, "index.ts"), "utf8"))
);
check("getPublicProfileBySlug uses the service client", body.includes("createServiceClient()"));
check("getPublicProfileBySlug never touches the session", !/await createClient\(\)|auth\.get(User|Session)/.test(body));

// Saving the public profile marks both the old and the new slug's page stale,
// only after a successful save, and with the slug in its stored form.
const save = readFileSync(join("src", "app", "api", "public-profile", "route.ts"), "utf8");
const put = save.slice(save.indexOf("export async function PUT("));
check("save route imports revalidatePath from next/cache", /import\s*\{\s*revalidatePath\s*\}\s*from\s*"next\/cache"/.test(save));
check("save route reads the old slug before saving", put.indexOf("getMyPublicProfile()") >= 0 && put.indexOf("getMyPublicProfile()") < put.indexOf("setMyPublicProfile("));
check("save route normalizes the new slug like the data layer", put.includes("normalizePublicSlug(body.slug)"));
check("save route revalidates /c/<slug> for old and new", /new Set\(\[oldSlug, newSlug\]\)/.test(put) && put.includes("revalidatePath(`/c/${s}`)"));
check(
  "revalidation happens only after the error return",
  put.indexOf('if ("error" in result)') >= 0 && put.indexOf('if ("error" in result)') < put.indexOf("revalidatePath(")
);
check("data layer stores slugs via the same normalizer", /normalizePublicSlug\(input\.slug\)/.test(data));

console.log(`c/[slug] ISR: ${passed} checks passed`);
