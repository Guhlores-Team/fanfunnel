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
check("boosts imports the read-failure helpers", boosts.includes('import { readFailed, readPublicCreator } from "./publicCreatorRow";') && /import \{[^}]*FanPassUnavailableError[^}]*\} from "\.\/unavailable";/.test(boosts));
for (const fn of ["getShareCard", "getSpinVerification"]) {
  const body = boosts.slice(boosts.indexOf(`export async function ${fn}(`));
  const end = body.indexOf("\nexport ");
  check(`${fn} throws FanPassUnavailableError on a failed read`, /if \(readFailed\((?:res\.)?error\)\) throw new FanPassUnavailableError\(/.test(body.slice(0, end)));
}
check("verify falls back only on an undefined column", (boosts.match(/if \(res\.error && isMissingColumnError\(res\.error\)\)/g) ?? []).length === 2);
const creatorRow = read("src/lib/data/publicCreatorRow.ts");
check("readPublicCreator throws on a failed read and nulls a missing row", creatorRow.includes("if (readFailed(error)) throw new FanPassUnavailableError(\"profiles read failed\");") && !/strict/.test(creatorRow) && creatorRow.includes("if (!data) return null;"));

const og = read("src/app/share/[shareId]/opengraph-image.tsx");
check("WA-04: the share image 404s for an unknown id", og.includes("if (!card) return new Response(null, { status: 404"));
check("WA-04: the share image is capped per address at the costly tier", og.includes("ROUTE_TIERS.costly") && og.includes("route:share-og:GET:") && og.includes("status: 429"));
check("WA-04: no placeholder prize in the image", !og.includes('"A prize"'));

const route = read("src/app/api/public/claim-check/route.ts");
check("WF-17: the claim check is a POST route at the costly tier", route.includes("export async function POST(") && route.includes('limitRoute(req, "public/claim-check:POST", "costly")'));
check("WF-17: a form post redirects with only the verdict, to a path on the same site",
  route.includes("Location: `/verify/${encodeURIComponent(shareId)}?claimed=${state}`") && route.includes("status: 303") && !/Location:[^\n]*\$\{code/.test(route) && !route.includes("req.url"));
const page = read("src/app/verify/[shareId]/page.tsx");
check("WF-17: the verify page reads no code from the URL", !/searchParams[^\n]*code/.test(page) && !page.includes("verifyClaimCode") && page.includes("claimedState("));
const form = read("src/app/verify/[shareId]/ClaimCheck.tsx");
check("WF-17: the form posts to the route (never GET)", form.includes('method="post"') && form.includes('action="/api/public/claim-check"') && !form.includes('method="get"'));

// WA-02: the root not-found is serialised into every page as its not-found
// boundary, so it must stay free of request APIs or the ISR creator page
// (/c/[slug], revalidate = 60) answers 500 at runtime.
const notFound = read("src/app/not-found.tsx");
check("the root not-found reads no request data (headers/cookies/searchParams)", !/next\/headers|cookies\(|headers\(|searchParams|connection\(|draftMode/.test(notFound));
check("the root not-found is a plain (non-async) static component", /export default function NotFound\(\)/.test(notFound));
for (const id of ["nf-link", "nf-verify", "nf-busy"]) check(`the root not-found carries the ${id} explanation`, notFound.includes(`id="${id}"`));
const kinds = read("src/components/fan/NotFoundKinds.tsx");
check("the kind is applied after hydration from the path, never from a request header", /^"use client";/.test(kinds) && kinds.includes("useSyncExternalStore") && kinds.includes("window.location.pathname"));
const css = read("src/app/globals.css");
check("the fragment shows a section without script", css.includes(".nf-kinds > .nf-kind:target { display: block; }"));
check("the creator page stays cached (ISR)", /export const revalidate = 60;/.test(read("src/app/c/[slug]/page.tsx")));
check("no proxy branch tags not-found requests any more", !read("src/proxy.ts").includes("not-found"));
for (const f of ["src/app/spin/[token]/page.tsx", "src/app/share/[shareId]/page.tsx", "src/app/verify/[shareId]/page.tsx", "src/app/c/[slug]/page.tsx", "src/app/leaderboard/[creatorId]/page.tsx"]) {
  check(`${f} sends a dead link to the branded 404`, read(f).includes("linkNotFound("));
}
console.log(`linkErrorPages.test: ${passed} checks passed`);
