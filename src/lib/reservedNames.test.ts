import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEGAL } from "./legal";
import { RESERVED_BRAND_WORDS, RESERVED_WORDS, RESERVED_WORD_TOKENS, foldName, isReservedName, nameKeys, nameWords } from "./reservedNames";

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
for (const w of [...RESERVED_WORDS, ...RESERVED_BRAND_WORDS, ...RESERVED_WORD_TOKENS]) check(`"${w}" is a plain lowercase key`, /^[a-z]+$/.test(w));
check("nameWords splits on separators and folds look-alikes", ["alice", "support"].every((w) => nameWords("Alice_Suppоrt").includes(w)));
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
  // a staff word as one of the name's words (the database's word rule)
  "Alice Support", "mod_dan", "The Admin Guy", "Staff Pick Fan", "jane.mods", "Team Admins",
  // official, system, root, security, billing, abuse: reserved as the name, digit-padded or joined, not as one word of many
  "official", "Official", "official2", "Official Support", "officialsupport", "Security Team", "security team", "System Admin", "Root", "root1",
  "Billing Team", "Abuse Team", "Official Security",
  // whole names the database also reserves
  "api", "www", "mail", "Terms", "@support", "@Admin",
];
for (const name of refused) check(`refused: "${name}"`, isReservedName(name));

// Allowed: real names, names that merely contain a reserved word, and the empty value.
const allowed = [
  "Alice", "Alice Smith", "Jane_Doe", "supportive_fan", "Modesty", "Teamster Tim", "Helpful Hannah", "JaneOfficial", "Unofficial Jane",
  "Rooted Ray", "Systematic Sue", "Mailman Mike", "Apiary Anna", "Terms And Tea",
  "Administrative Assistant", "Verify Vicky Wins", "Bot Fan 99", "Infographic", "Contactless", "Legally Blonde Fan",
  "Sam", "x", "Secure Sally", "Billie", "Pay Pal", "The Owner Of Cats", "Funnel Cake", "Fan of Funnels",
  "Jane Official", "Official Jane", "jane-official", "Jane (Official)", "Root Beer Fan", "System Shock", "Security Sam", "Billing Bob", "Abuse Report",
  "mo", "a1", "", "   ",
];
for (const name of allowed) check(`allowed: "${name}"`, !isReservedName(name));
check("null and undefined are not reserved", !isReservedName(null) && !isReservedName(undefined));

// --- at least as strict as the database -------------------------------------
// A port of public._reserved_name() (0073). Its two word lists are read from
// the migration itself, so a change to the SQL rule reaches this test.
const MIGRATIONS = join(import.meta.dirname, "../../supabase/migrations");
const sql = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");
const def = [...sql.matchAll(/create or replace function public\._reserved_name\(p text\)[\s\S]*?\$\$;/g)].at(-1)?.[0] ?? "";
check("a migration defines public._reserved_name(text)", def.length > 0);
const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
// One reserved word, or up to three joined, after digits are trimmed from both ends.
const SQL_JOINED = /n\.whole, '\^\[0-9\]\+\|\[0-9\]\+\$', '', 'g'\) ~ '\^\(([a-z|]+)\)\{1,3\}\$'/.exec(def)?.[1] ?? "";
const SQL_WHOLE = SQL_JOINED.split("|").filter(Boolean);
const SQL_JOINED_RE = new RegExp(`^(?:${SQL_WHOLE.join("|")}){1,3}$`);
const SQL_LIKE = quoted([...def.matchAll(/n\.whole like ('%[^']+%')/g)].map((m) => m[1]).join(" ")).map((l) => l.replace(/%/g, ""));
const SQL_WORDS = quoted(/n\.words && array\[([\s\S]*?)\]/.exec(def)?.[1] ?? "");
check("the SQL whole-name list was read", SQL_WHOLE.length >= 20 && SQL_WHOLE.includes("fanfunnel") && SQL_WHOLE.includes("terms"));
check("the SQL contains-list was read", SQL_LIKE.includes("fanfunnel") && SQL_LIKE.includes("easysimplesites"));
check("the SQL word list was read", SQL_WORDS.length >= 6 && SQL_WORDS.includes("admin") && SQL_WORDS.includes("mod"));
for (const word of ["official", "system", "root", "security", "billing", "abuse"]) {
  check(`"${word}" is reserved as a name in SQL and here, and is a word-level refusal in neither`, SQL_WHOLE.includes(word) && !SQL_WORDS.includes(word)
    && (RESERVED_WORDS as readonly string[]).includes(word) && !(RESERVED_WORD_TOKENS as readonly string[]).includes(word));
}
check("every SQL word-level refusal is one here too", SQL_WORDS.every((w) => (RESERVED_WORD_TOKENS as readonly string[]).includes(w)));
check("every SQL reserved name is a reserved word or a brand word here", SQL_WHOLE.every((w) => (RESERVED_WORDS as readonly string[]).includes(w) || (RESERVED_BRAND_WORDS as readonly string[]).includes(w)));
check("the SQL normalisation is the one this port copies", def.includes("'^\\s*@'") && def.includes("'[\\s._-]+'") && def.includes("'[^[:alnum:]]+'") && def.includes("'^[0-9]+|[0-9]+$'"));

/** The SQL rule; `ascii` picks how [:alnum:] splits words (C locale vs a UTF-8 locale). */
function sqlReserved(p: string, ascii: boolean): boolean {
  if (p === "") return false;
  const whole = p.replace(/^\s*@/, "").replace(/[\s._-]+/g, "").toLowerCase();
  const words = p.replace(ascii ? /[^A-Za-z0-9]+/g : /[^\p{L}\p{N}]+/gu, " ").toLowerCase().split(/\s+/);
  const bare = whole.replace(/^[0-9]+|[0-9]+$/g, "");
  return SQL_JOINED_RE.test(bare) || SQL_LIKE.some((l) => whole.includes(l)) || words.some((w) => SQL_WORDS.includes(w));
}

// The SQL rule's own cases, as fixtures: [name, the database refuses it].
const SQL_CASES: [string, boolean][] = [
  ["FanFunnel", true], ["fan funnel", true], ["Fan.Funnel-Official", true], ["TheFanFunnelFan", true], ["easysimplesites", true],
  ["support", true], ["Support", true], ["@support", true], ["  @Admin", true], ["s.u.p.p.o.r.t", true], ["ad-min", true],
  ["help", true], ["verify", true], ["team", true], ["legal", true], ["privacy", true], ["terms", true], ["api", true], ["www", true],
  ["mail", true], ["abuse", true], ["system", true], ["root", true], ["Mod", true], ["official", true],
  ["Alice Support", true], ["mod_dan", true], ["The Admin Guy", true], ["Staff Pick Fan", true],
  ["Support!", true], ["ADMINISTRATOR x", true], ["Official Moderator", true],
  // reserved as a name, digit-padded or joined: the whole-name rule
  ["admin1", true], ["2support", true], ["official2", true], ["officialsupport", true], ["Official Support", true],
  ["Security Team", true], ["security_team", true], ["Team Mail Help", true], ["System Admin", true], ["rootroot", true],
  // official, system, root, security, billing, abuse as one word of a longer name
  ["Jane Official", false], ["Official Jane", false], ["jane-official", false], ["Jane (Official)", false], ["Security Sam", false],
  ["Root Beer Fan", false], ["System Shock", false], ["Billing Bob", false], ["Abuse Report", false], ["Team Mail Help Api", false],
  // …and what it lets through
  ["Alice", false], ["Alice Adminton", false], ["JaneOfficial", false], ["supportive_fan", false], ["Help Desk", false],
  ["Team Jane", false], ["Verify Vicky", false], ["Legal Eagle", false], ["Supp0rt", false], ["Mods", false], ["123", false],
  ["mailman", false], ["apiary", false], ["Terms And Tea", false], ["", false],
];
for (const [name, refused] of SQL_CASES) {
  check(`SQL rule fixture: "${name}" → ${refused ? "refused" : "allowed"}`, sqlReserved(name, false) === refused);
}

// Every name the database refuses, under either word split, this rule refuses too.
const corpus = new Set<string>([...SQL_CASES.map(([n]) => n), ...refused, ...allowed]);
for (const w of new Set([...SQL_WHOLE, ...SQL_WORDS, ...SQL_LIKE])) {
  for (const shape of [w, w.toUpperCase(), `@${w}`, ` ${w} `, [...w].join("."), [...w].join("-"), [...w].join("_"), [...w].join(" "),
    `Alice ${w}`, `${w} Alice`, `alice-${w}`, `${w}_alice`, `alice.${w}.fan`, `Alice (${w})`, `${w}!`, `${w}é`, `é${w}`, `Alice/${w}`,
    `x${w}x`, `${w}${w}`, `the${w}`, `${w}1`]) corpus.add(shape);
}
let sqlRefused = 0;
for (const name of corpus) {
  for (const ascii of [false, true]) {
    if (!sqlReserved(name, ascii)) continue;
    sqlRefused++;
    check(`the database refuses "${name}" (${ascii ? "C" : "UTF-8"} word split), so this rule must`, isReservedName(name));
  }
}
check("the corpus exercised the SQL rule", sqlRefused > 300);

console.log(`reserved names: ${passed} checks passed`);
