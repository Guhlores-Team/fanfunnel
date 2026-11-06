import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NEUTRAL_CREATOR_TITLE, isPublicCreator, publicCreatorName, publicCreatorTitle } from "./publicCreator";

// M1 / L5: the rule every public creator surface shares, plus static guards
// that no title builder bypasses it and nothing sends the e-mail as a name.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

check("a real name is kept", publicCreatorTitle("Bella Rose") === "Bella Rose");
check("whitespace is collapsed and trimmed", publicCreatorTitle("  Bella \n Rose ") === "Bella Rose");
for (const raw of [null, undefined, "", "   ", "bella@example.com", " Bella@Example.com ", "bella (bella@example.com)", "@bella"]) {
  check(`${JSON.stringify(raw)} becomes the neutral label`, publicCreatorTitle(raw) === NEUTRAL_CREATOR_TITLE);
  check(`${JSON.stringify(raw)} has no public name`, publicCreatorName(raw) === null);
}
check("the neutral label is the existing missing-name copy", NEUTRAL_CREATOR_TITLE === "Creator");

const row = { id: "c", display_name: "B", is_active: true, approval_status: "approved", role: "creator" };
check("active + approved is public", isPublicCreator(row));
check("an active admin is public without approval", isPublicCreator({ ...row, role: "admin", approval_status: "pending" }));
for (const [label, patch] of [
  ["suspended", { is_active: false }],
  ["is_active unknown", { is_active: null }],
  ["pending", { approval_status: "pending" }],
  ["rejected", { approval_status: "rejected" }],
  ["approval unknown", { approval_status: null }],
  ["suspended admin", { is_active: false, role: "admin" }],
] as const) {
  check(`${label} is not public`, !isPublicCreator({ ...row, ...patch }));
}
check("no row is not public", !isPublicCreator(null));

// Static: no code sends or falls back to the e-mail as the display name, and
// every creator title built for a public surface goes through the helper.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(e) && !e.includes(".test.") ? [p] : [];
  });
}
const src = files("src");
for (const f of src) {
  const text = readFileSync(f, "utf8");
  // The stored field (snake case): admin-only labels may still show an e-mail.
  check(`${f}: never stores the e-mail as a display name`, !/display_name:\s*[\w?.]*\s*(\|\||\?\?)\s*email\b/.test(text));
  check(`${f}: builds no creator title from a raw display_name`, !/creatorTitle:\s*[\w?.]*display_name\b/.test(text));
}
const login = readFileSync("src/components/LoginForm.tsx", "utf8");
check("sign-up sends a display name only when one was typed", /displayName\.trim\(\) \? \{ display_name: displayName\.trim\(\) \} : \{\}/.test(login));
for (const f of ["src/lib/data/spins.ts", "src/lib/data/pwa.ts", "src/lib/data/boosts.ts", "src/lib/data/publicProfile.ts"]) {
  const text = readFileSync(f, "utf8");
  check(`${f} builds creator titles with publicCreatorTitle`, text.includes("publicCreatorTitle(") && !/display_name \?\? "Creator"/.test(text));
}
for (const f of ["src/lib/data/publicProfile.ts", "src/lib/data/boosts.ts"]) {
  check(`${f} reads public creators through readPublicCreator`, readFileSync(f, "utf8").includes("readPublicCreator("));
}

// L5: suspending (or reactivating) an account drops the ISR'd /c/<slug> pages.
check("the admin account route revalidates public pages on an is_active change",
  /typeof body\.isActive === "boolean"\) \{[\s\S]*?revalidatePath\("\/c\/\[slug\]", "page"\)/.test(readFileSync("src/app/api/admin/account/route.ts", "utf8")));

console.log(`publicCreator: ${passed} checks passed`);
