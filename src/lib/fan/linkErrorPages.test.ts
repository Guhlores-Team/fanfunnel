import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// OPS3-06 / WA-04 / WF-17 (static): every public link page has an error
// boundary, its reader throws on a failed read, the share image answers 404
// for an unknown id behind a per-address cap, and the claim code is POSTed.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

for (const seg of ["src/app/verify/[shareId]", "src/app/leaderboard/[creatorId]", "src/app/share/[shareId]", "src/app/c/[slug]"]) {
  check(`${seg} has an error boundary`, existsSync(join(root, seg, "error.tsx")));
  const err = read(`${seg}/error.tsx`);
  check(`${seg} error boundary is a client RouteErrorView with retry`, /^"use client";/.test(err) && err.includes("RouteErrorView") && err.includes("retry="));
  check(`${seg} keeps metadata blocking (no loading.tsx)`, !existsSync(join(root, seg, "loading.tsx")));
}

const boosts = read("src/lib/data/boosts.ts");
check("boosts imports the read-failure helpers", boosts.includes('import { PublicReadError, readFailed, readPublicCreator } from "./publicCreatorRow";'));
for (const fn of ["getShareCard", "getSpinVerification"]) {
  const body = boosts.slice(boosts.indexOf(`export async function ${fn}(`));
  const end = body.indexOf("\nexport ");
  check(`${fn} throws PublicReadError on a failed read`, body.slice(0, end).includes("throw new PublicReadError("));
}
check("verify falls back only on an undefined column (42703)", boosts.includes('const MISSING_COLUMN = "42703";') && boosts.includes("res.error?.code === MISSING_COLUMN"));
const creatorRow = read("src/lib/data/publicCreatorRow.ts");
check("readPublicCreator throws on a failed read and nulls a missing row", creatorRow.includes("if (readFailed(error)) throw new PublicReadError(\"profiles\", error);") && creatorRow.includes("if (!data) return null;"));

const og = read("src/app/share/[shareId]/opengraph-image.tsx");
check("WA-04: the share image 404s for an unknown id", og.includes("if (!card) return new Response(null, { status: 404"));
check("WA-04: the share image is capped per address at the costly tier", og.includes("ROUTE_TIERS.costly") && og.includes("route:share-og:GET:") && og.includes("status: 429"));
check("WA-04: no placeholder prize in the image", !og.includes('"A prize"'));

const route = read("src/app/api/public/claim-check/route.ts");
check("WF-17: the claim check is a POST route at the costly tier", route.includes("export async function POST(") && route.includes('limitRoute(req, "public/claim-check:POST", "costly")'));
check("WF-17: a form post redirects with only the verdict", route.includes('to.searchParams.set("claimed", state)') && route.includes("status: 303"));
const page = read("src/app/verify/[shareId]/page.tsx");
check("WF-17: the verify page reads no code from the URL", !/searchParams[^\n]*code/.test(page) && !page.includes("verifyClaimCode") && page.includes("claimedState("));
const form = read("src/app/verify/[shareId]/ClaimCheck.tsx");
check("WF-17: the form posts to the route (never GET)", form.includes('method="post"') && form.includes('action="/api/public/claim-check"') && !form.includes('method="get"'));

console.log(`linkErrorPages.test: ${passed} checks passed`);
