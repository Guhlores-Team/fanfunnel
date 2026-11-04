import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicGameCopy, publicGameKind } from "./publicCopy";

// A52: public surfaces (link-in-bio, share card, OG image) speak the creator's
// live game. A scratch or bingo creator is never advertised as a wheel.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

check("unknown kinds read as the wheel", publicGameKind(undefined) === "wheel" && publicGameKind("roulette") === "wheel" && publicGameKind(null) === "wheel");
check("scratch and bingo are kept", publicGameKind("scratch") === "scratch" && publicGameKind("bingo") === "bingo");

const wheel = publicGameCopy("wheel");
check("the wheel keeps its established copy", wheel.titleSuffix === "Prize Wheel" && wheel.cta === "Get your spins →" && wheel.emoji === "🎡"
  && wheel.wonOn("Ava") === "Won on Ava’s prize wheel — every spin wins." && wheel.dropOn("Rare", "Ava") === "A Rare drop on Ava's wheel.");

for (const kind of ["scratch", "bingo"] as const) {
  const copy = publicGameCopy(kind);
  const lines = [copy.titleSuffix, copy.defaultTagline, copy.metaDescription, copy.cta, copy.dmLine("Ava"), copy.everyPlayWins,
    copy.wonOn("Ava"), copy.dropOn("Rare", "Ava"), copy.ogFooter, copy.shareFooter];
  check(`${kind}: no line mentions a wheel or spinning`, lines.every((line) => !/wheel|spin/i.test(line)));
  check(`${kind}: no wheel emoji`, copy.emoji !== "🎡" && lines.every((line) => !line.includes("🎡")));
  check(`${kind}: every line is filled and names the creator where it should`, lines.every((line) => line.trim().length > 0)
    && copy.dmLine("Ava").includes("Ava") && copy.wonOn("Ava").includes("Ava") && copy.dropOn("Rare", "Ava").includes("Rare"));
  check(`${kind}: the copy record is the kind asked for`, copy.kind === kind);
}
check("scratch copy names tickets", /ticket/i.test(publicGameCopy("scratch").titleSuffix) && /ticket/i.test(publicGameCopy("scratch").cta));
check("bingo copy names bingo", /bingo/i.test(publicGameCopy("bingo").titleSuffix) && /bingo/i.test(publicGameCopy("bingo").wonOn("Ava")));

// The public pages take every game-dependent line from publicGameCopy; none
// hard-codes the wheel's copy again.
for (const file of ["src/app/c/[slug]/page.tsx", "src/app/share/[shareId]/page.tsx", "src/app/share/[shareId]/opengraph-image.tsx", "src/components/dashboard/ThemedProfilePreview.tsx"]) {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  check(`${file} uses publicGameCopy`, source.includes("publicGameCopy("));
  check(`${file} has no hard-coded wheel copy`, !/Prize Wheel|prize wheel|Get your spins|personal spin link|every spin wins|Every spin wins|'s wheel|🎡/.test(source));
}

console.log(`publicCopy.test: ${passed} checks passed`);
