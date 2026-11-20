import assert from "node:assert";
import { normalizePublicSlug, slugHint } from "./publicSlug";

// WC-30: the Settings handle field says what a save would store and what it
// would break, with the same rules the save route applies.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

check("normalizes case, spaces and edges", normalizePublicSlug("  Walk Creator ") === "walk-creator");

const clean = slugHint("bella", "bella");
check("an unchanged handle says nothing", clean.problem === null && clean.savedAs === null && clean.retires === null);

const spaced = slugHint("Walk Creator", "");
check("a spaced name previews its stored form", spaced.savedAs === "walk-creator" && spaced.problem === null);
check("a first handle retires nothing", spaced.retires === null);

const bad = slugHint("Walk Creator!!", "demo-creator");
check("punctuation the route refuses is flagged while typing", bad.problem === "invalid_slug");
check("a refused handle shows no 'saved as' line", bad.savedAs === null);
check("a rename warns that the current link stops working", bad.retires === "demo-creator");

check("a too-long handle is flagged", slugHint("a".repeat(65), "").problem === "invalid_slug");
check("64 characters is allowed", slugHint("a".repeat(64), "").problem === null);
check("a reserved name is flagged", slugHint("admin", "").problem === "slug_reserved");
check("the brand is reserved", slugHint("fanfunnel-support", "").problem === "slug_reserved");
check("a rename to a clean handle warns once", slugHint("bella-new", "bella").retires === "bella" && slugHint("bella-new", "bella").savedAs === null);
check("retyping the saved handle in capitals retires nothing", slugHint("Bella", "bella").retires === null && slugHint("Bella", "bella").savedAs === "bella");
check("clearing the handle retires the live link", slugHint("", "bella").retires === "bella" && slugHint("", "bella").problem === null);

console.log(`publicSlug: ${passed} checks passed`);
