import assert from "node:assert/strict";
import { LEGAL } from "./legal";
import { RESERVED_BRAND_WORDS, RESERVED_WORDS, foldName, isReservedName, nameKeys } from "./reservedNames";

// TS-03: nobody may present as FanFunnel, its staff or a look-alike of them,
// on any public name surface. Both directions are pinned: the names a scammer
// would pick are refused, and ordinary names (including ones that merely
// contain a reserved word) are not.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

// The operator's own names normalise into the brand list, so renaming the
// operator (legal.ts) without updating this list fails here.
for (const own of [LEGAL.operator, LEGAL.product, LEGAL.contactEmail.split("@")[1].replace(/\.[a-z]+$/i, "")]) {
  check(`"${own}" is a reserved brand word`, RESERVED_BRAND_WORDS.includes(foldName(own) as (typeof RESERVED_BRAND_WORDS)[number]));
}

// Every listed word is lowercase letters only (the SQL mirror compares the same keys).
for (const w of [...RESERVED_WORDS, ...RESERVED_BRAND_WORDS]) check(`"${w}" is a plain lowercase key`, /^[a-z]+$/.test(w));
check("no duplicate reserved words", new Set(RESERVED_WORDS).size === RESERVED_WORDS.length);

// Normalisation.
check("foldName strips accents, case and separators", foldName("Fán_Fun-nel. ") === "fanfunnel");
check("foldName folds Cyrillic look-alikes", foldName("Fаnfunnеl") === "fanfunnel"); // Cyrillic а and е
check("foldName keeps digits and leet symbols for both readings", foldName("5upp0rt!") === "5upp0rt!");
check("nameKeys reads leet both ways", nameKeys("Fanfunne1").includes("fanfunnel") && nameKeys("Fanfunne1").includes("fanfunnei"));
check("nameKeys trims digits from the ends", nameKeys("admin2024").includes("admin"));
check("nameKeys of a blank name is empty", nameKeys("  ").length === 0);
check("nameKeys bounds the leet expansion", nameKeys("1".repeat(40)).length <= 2 ** 6 * 2 + 2);

// Refused: the brand anywhere, staff words alone/padded/joined, leet and homoglyphs.
const refused = [
  "FanFunnel", "fanfunnel", "Fan Funnel", "fan_funnel", "Fan.Funnel", "TheFanFunnel", "fanfunnel2", "FanFunnel Support",
  "Fanfunne1", "F4nFunnel", "Fаnfunnel", "FANFUNNEL_OFFICIAL", "easysimplesites", "Easy Simple Sites",
  "Support", "support", "Admin", "admin1", "2admin", "Administrator", "Staff", "Official", "Moderator", "mod", "Help",
  "Security", "Billing", "Verify", "Verified", "Team", "Legal", "Privacy", "Safety", "DMCA", "Trust & Safety",
  "Support Team", "support_team", "official.support", "Help Desk", "mod-team", "Admin Team 1", "5upport", "$upport",
  "Supp0rt", "0fficial", "Adm1n", "Sta ff", "Suppоrt", "SUPPORT!!", "admin-bot", "verify.team", "Official Admin Team",
  "N0 Reply", "Billing Support", "Customer Service", "fanfunnel.help",
];
for (const name of refused) check(`refused: "${name}"`, isReservedName(name));

// Allowed: real names, names that merely contain a reserved word, and the empty value.
const allowed = [
  "Alice", "Alice Smith", "Jane_Doe", "supportive_fan", "Modesty", "Teamster Tim", "Helpful Hannah", "Official Jane",
  "Administrative Assistant", "Verify Vicky Wins", "Bot Fan 99", "Infographic", "Contactless", "Legally Blonde Fan",
  "Sam", "x", "Secure Sally", "Billie", "Pay Pal", "The Owner Of Cats", "Funnel Cake", "Fan of Funnels",
  "mo", "a1", "", "   ",
];
for (const name of allowed) check(`allowed: "${name}"`, !isReservedName(name));
check("null and undefined are not reserved", !isReservedName(null) && !isReservedName(undefined));

console.log(`reserved names: ${passed} checks passed`);
