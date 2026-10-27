/**
 * RM-4 manifest builder: token handling and the D8 icon/name rules.
 *
 * The fan's link token is a bearer credential, so it may appear only in the
 * same-origin paths of that one link's app (id, start_url, scope, icons), never
 * in the name/description, and a malformed token must never produce a manifest.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  avatarSource,
  buildFanManifest,
  buildRootManifest,
  fanAppName,
  fanAppPaths,
  iconVersion,
  isValidFanToken,
  normalizeIconMode,
  parseIconVariant,
  shortName,
  usesAvatarIcon,
  type FanAppInfo,
} from "./manifest";
import {
  DEFAULT_PWA_ICON_MODE,
  FAN_APP_CACHE_CONTROL,
  NEUTRAL_APP_NAME,
  SERVICE_WORKER_SCOPE,
} from "./config";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SUPA = "https://abc.supabase.co";
const AVATAR = `${SUPA}/storage/v1/object/public/avatars/u1/face.png`;
const neutral: FanAppInfo = { creatorTitle: "Nova Rae", brandColor: "#8b5cf6", iconMode: "neutral", avatarUrl: AVATAR };
const avatar: FanAppInfo = { ...neutral, iconMode: "avatar" };

// --- token handling ---------------------------------------------------------
check("a randomToken()-shaped token is valid", isValidFanToken(TOKEN));
check("the demo store's short token is valid", isValidFanToken("demo"));
for (const bad of ["", "a/b", "../x", "a b", "a?b", "a#b", "a%2Fb", "x".repeat(129), "tök"]) {
  check(`rejects malformed token ${JSON.stringify(bad.slice(0, 20))}`, !isValidFanToken(bad));
  assert.throws(() => fanAppPaths(bad), /invalid fan token/);
  assert.throws(() => buildFanManifest(bad, neutral), /invalid fan token/);
  passed += 2;
}
check("non-strings are not tokens", !isValidFanToken(undefined) && !isValidFanToken(42));

const m = buildFanManifest(TOKEN, neutral);
check("start_url opens this fan's own link", m.start_url === `/spin/${TOKEN}?src=pwa`);
check("scope is this link only", m.scope === `/spin/${TOKEN}`);
check("id is per link (two links install as two apps)", m.id === `/spin/${TOKEN}`);
check("start_url is inside scope", String(m.start_url).startsWith(String(m.scope)));
check("display is standalone", m.display === "standalone");
check("theme colour is the creator's brand", m.theme_color === "#8b5cf6");
check("every icon is a same-origin path of this link", (m.icons ?? []).every((i) => i.src.startsWith(`/spin/${TOKEN}/icon/`)));
check("no absolute URL anywhere (nothing for a third party to fetch)", !/https?:\/\//.test(JSON.stringify(m)));
check("token only in id/start_url/scope/icons", (() => {
  const { id: _id, start_url: _s, scope: _sc, icons: _i, ...rest } = m;
  return !JSON.stringify(rest).includes(TOKEN);
})());
check("has the 192 and 512 icons Chrome requires", ["192x192", "512x512"].every((s) => (m.icons ?? []).some((i) => i.sizes === s && i.purpose === "any")));
check("has a maskable icon", (m.icons ?? []).some((i) => i.purpose === "maskable"));
check("every icon is a PNG", (m.icons ?? []).every((i) => i.type === "image/png"));
const other = buildFanManifest("abcdef0123456789abcdef0123456789", neutral);
check("a different token gets a different app", other.id !== m.id && other.start_url !== m.start_url);

// --- D8: name and icon follow pwa_icon_mode ----------------------------------
check("default mode is neutral", DEFAULT_PWA_ICON_MODE === "neutral");
check("neutral: app name is the neutral name", m.name === NEUTRAL_APP_NAME && m.short_name === NEUTRAL_APP_NAME);
check("neutral: the creator's name appears nowhere", !JSON.stringify(m).includes("Nova"));
check("neutral: the icon is the glyph even with an avatar on file", !usesAvatarIcon(neutral));
const a = buildFanManifest(TOKEN, avatar);
check("avatar: app name is the creator's display name", a.name === "Nova Rae");
check("avatar: the icon is the avatar", usesAvatarIcon(avatar));
check("avatar without a usable avatar: glyph icon, creator name", !usesAvatarIcon({ ...avatar, avatarUrl: null }) && fanAppName(avatar) === "Nova Rae");
check("avatar with a blank name falls back to neutral", fanAppName({ creatorTitle: "  ", iconMode: "avatar" }) === NEUTRAL_APP_NAME);
check("long names get a short_name", shortName("Supercalifragilistic") === "Supercalifr…" && Array.from(shortName("Supercalifragilistic")).length === 12);
check("short names are kept", shortName("Nova") === "Nova");
check("unknown modes normalise to neutral", normalizeIconMode("selfie") === "neutral" && normalizeIconMode(null) === "neutral");
check("valid modes are kept", normalizeIconMode("avatar") === "avatar");
check("icon URLs change with the mode", iconVersion(neutral) !== iconVersion(avatar));
check("icon URLs change with the brand colour in neutral mode", iconVersion(neutral) !== iconVersion({ ...neutral, brandColor: "#10b981" }));
check("icon URLs change with the avatar in avatar mode", iconVersion(avatar) !== iconVersion({ ...avatar, avatarUrl: AVATAR + "?2" }));
check("icon version is URL-safe", /^[a-z0-9]+$/.test(iconVersion(avatar)));
check("manifest icons carry the version", (a.icons ?? []).every((i) => i.src.endsWith(`?v=${iconVersion(avatar)}`)));

// The database default (migration 0046) must equal the code default.
const mig = readFileSync(join(import.meta.dirname, "../../../supabase/migrations/0046_pwa_icon_mode.sql"), "utf8");
check("migration 0046 defaults to the code default", mig.includes(`default '${DEFAULT_PWA_ICON_MODE}'`));

// --- icon variants ------------------------------------------------------------
check("192 is a plain icon", JSON.stringify(parseIconVariant("192")) === JSON.stringify({ size: 192, maskable: false }));
check("maskable-512 is maskable", parseIconVariant("maskable-512")?.maskable === true);
check("180 (apple-touch-icon) exists", parseIconVariant("180")?.size === 180);
check("unknown variants are refused", [ "1024", "0", "../512", "constructor", "toString", "__proto__"].every((v) => parseIconVariant(v) === null));

// --- avatar source: only the project's public avatars bucket (no SSRF) ---------
check("bucket avatar is allowed", avatarSource(AVATAR, SUPA) === AVATAR);
check("no Supabase URL → no avatar", avatarSource(AVATAR, undefined) === null);
check("other hosts are refused", avatarSource("https://evil.example/storage/v1/object/public/avatars/x.png", SUPA) === null);
check("other buckets are refused", avatarSource(`${SUPA}/storage/v1/object/public/other/x.png`, SUPA) === null);
check("signed/private paths are refused", avatarSource(`${SUPA}/storage/v1/object/sign/avatars/x.png`, SUPA) === null);
check("plain http is refused for an https project", avatarSource(AVATAR.replace("https:", "http:"), SUPA) === null);
check("credentials in the URL are refused", avatarSource(`https://u:p@abc.supabase.co/storage/v1/object/public/avatars/x.png`, SUPA) === null);
check("non-URLs are refused", avatarSource("javascript:alert(1)", SUPA) === null && avatarSource("", SUPA) === null);

// --- root manifest: the dashboard app, no token -------------------------------
const root = buildRootManifest();
check("root app starts at the dashboard", root.start_url === "/dashboard");
check("root app has PNG icons only", (root.icons ?? []).length >= 2 && (root.icons ?? []).every((i) => i.type === "image/png"));
check("root app has 192 and 512 icons", ["192x192", "512x512"].every((s) => (root.icons ?? []).some((i) => i.sizes === s)));
check("root manifest carries no spin link", !/\/spin\//.test(JSON.stringify(root)));
check("the service worker scope is inside the dashboard app", String(root.start_url).startsWith(SERVICE_WORKER_SCOPE));

// --- cache policy for token-bearing responses ---------------------------------
check("token responses are private", /^private\b/.test(FAN_APP_CACHE_CONTROL));
check("token responses are never shared-cacheable", !/s-maxage|public|immutable/.test(FAN_APP_CACHE_CONTROL));

console.log(`pwa manifest: ${passed} checks passed`);
