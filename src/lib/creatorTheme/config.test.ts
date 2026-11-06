import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTION_MAX,
  DEFAULT_THEME,
  MAX_EDGE_PX,
  MAX_MEDIA,
  MAX_STORED_BYTES,
  MEDIA_BUCKET,
  THEME_BACKGROUNDS,
  THEME_FONTS,
  isMediaPath,
  normalizeCaption,
  normalizeTheme,
  parseThemeInput,
  toDbTheme,
} from "./config";

// Per-creator theming: the app's allow-lists and limits match migration 0058
// (set_creator_theme, creator_media, the bucket), and the theme parsers refuse
// anything that isn't a known key, so no URL, colour or CSS can be saved.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const sql = readFileSync(join(import.meta.dirname, "../../../supabase/migrations/0058_creator_theme_media.sql"), "utf8");
const list = (anchor: string) => {
  const m = sql.match(new RegExp(`\\(p_theme ->> '${anchor}'\\) not in \\(([^)]*)\\)`));
  assert.ok(m, `0058 lists the allowed ${anchor} values`);
  return m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
};

// --- 1. SQL and TS allow-lists / limits are the same ---------------------------
{
  check("fonts match set_creator_theme", JSON.stringify(list("font")) === JSON.stringify([...THEME_FONTS]));
  check("backgrounds match set_creator_theme", JSON.stringify(list("background")) === JSON.stringify([...THEME_BACKGROUNDS]));
  check("SQL default font is the app default", sql.includes(`v_font text := '${DEFAULT_THEME.font}'`));
  check("SQL default background is the app default", sql.includes(`v_bg text := '${DEFAULT_THEME.background}'`));
  check("the photo cap matches", sql.includes(`>= ${MAX_MEDIA} then`));
  check("the caption limit matches", sql.includes(`char_length(caption) <= ${CAPTION_MAX}`));
  check("the edge limit matches", sql.includes(`between 1 and ${MAX_EDGE_PX}`));
  check("the bucket and its size limit match", sql.includes(`('${MEDIA_BUCKET}', '${MEDIA_BUCKET}', true, ${MAX_STORED_BYTES}, array['image/webp'])`));
  check("deleting the background photo resets to the default", sql.includes(`jsonb_build_object('background', '${DEFAULT_THEME.background}')`));
}

// --- 2. Reading a stored theme is tolerant (a bad row never breaks a page) -----
{
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  check("{} → default", eq(normalizeTheme({}), DEFAULT_THEME));
  check("null → default", eq(normalizeTheme(null), DEFAULT_THEME));
  check("array → default", eq(normalizeTheme(["syne"]), DEFAULT_THEME));
  check("a valid theme reads back", eq(normalizeTheme({ font: "syne", background: "aurora" }), { font: "syne", background: "aurora", bgMediaId: null }));
  check("unknown font → default font", normalizeTheme({ font: "Comic Sans", background: "noir" }).font === "bricolage");
  check("CSS in background → default background", normalizeTheme({ background: "url(x)" }).background === "glow");
  const id = "123e4567-e89b-42d3-a456-426614174000";
  check("photo with id reads back", eq(normalizeTheme({ background: "photo", bg_media_id: id }), { font: "bricolage", background: "photo", bgMediaId: id }));
  check("photo without id → glow", eq(normalizeTheme({ background: "photo" }), DEFAULT_THEME));
  check("photo with junk id → glow", normalizeTheme({ background: "photo", bg_media_id: "../../etc" }).background === "glow");
  check("an id without the photo background is dropped", normalizeTheme({ background: "noir", bg_media_id: id }).bgMediaId === null);
}

// --- 3. Writing is strict --------------------------------------------------------
{
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const err = (raw: unknown) => {
    const r = parseThemeInput(raw);
    return "error" in r ? r.error : null;
  };
  check("unknown font refused", err({ font: "Comic Sans" }) === "invalid_font");
  check("non-string font refused", err({ font: { family: "x" } }) === "invalid_font");
  check("url() background refused", err({ background: "url(https://evil.example/x.png)" }) === "invalid_background");
  check("photo without id refused", err({ background: "photo" }) === "invalid_photo");
  check("photo with a path instead of an id refused", err({ background: "photo", bgMediaId: "a/b.webp" }) === "invalid_photo");
  check("empty input → the defaults", JSON.stringify(parseThemeInput({})) === JSON.stringify({ theme: DEFAULT_THEME }));
  const ok = parseThemeInput({ font: "fraunces", background: "photo", bgMediaId: id, css: "body{}", creatorId: "someone-else" });
  check("a valid photo theme parses; extra fields are dropped", "theme" in ok && JSON.stringify(ok.theme) === JSON.stringify({ font: "fraunces", background: "photo", bgMediaId: id }));
  check("toDbTheme for a photo", JSON.stringify(toDbTheme({ font: "syne", background: "photo", bgMediaId: id })) === JSON.stringify({ font: "syne", background: "photo", bg_media_id: id }));
  check("toDbTheme drops a stray id", JSON.stringify(toDbTheme({ font: "syne", background: "glow", bgMediaId: id })) === JSON.stringify({ font: "syne", background: "glow" }));
}

// --- 4. Paths and captions -------------------------------------------------------
{
  const u = "123e4567-e89b-42d3-a456-426614174000";
  check("a stored path is accepted", isMediaPath(`${u}/${u}.webp`));
  for (const bad of [`${u}/${u}.svg`, `${u}/../${u}.webp`, `/${u}/${u}.webp`, `${u}/${u}.webp?x=1`, `https://x/${u}.webp`, `${u}/${u}.WEBP`, 7]) {
    check(`path ${JSON.stringify(bad)} refused`, !isMediaPath(bad));
  }
  check("caption trimmed", normalizeCaption("  hi  ") === "hi");
  check("empty caption → null", normalizeCaption("   ") === null);
  check("non-string caption → null", normalizeCaption({}) === null);
  check("caption capped", normalizeCaption("x".repeat(500))!.length === CAPTION_MAX);
  check("control characters removed", normalizeCaption("a\u0000b\nc") === "a b c");
}

console.log(`creatorTheme/config.test.ts: ${passed} checks passed`);
