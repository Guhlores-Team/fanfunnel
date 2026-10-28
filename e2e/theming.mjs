// Per-creator appearance and photo-hub browser journey. Register before the
// final firstRunJourney reset. All data comes through real demo APIs; the
// fixture owns its wheel, fan and uploaded photos and restores the prior look.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ARTIFACTS, BASE, ensureArtifacts, goto } from "./harness.mjs";

export const THEME_FONT_CASES = [
  ["playfair", "Playfair"], ["dm-serif", "DM_Serif"], ["syne", "Syne"],
  ["fraunces", "Fraunces"], ["unbounded", "Unbounded"], ["bricolage", "Bricolage"],
];
export const THEME_PRESETS = ["glow", "velvet", "noir", "aurora", "solid"];
let fixtureNumber = 0;

export async function themeJson(response, operation) {
  if (!response.ok()) throw new Error(`${operation} failed (${response.status()})`);
  return response.json();
}

/** Small real RGB PNG; tests cover both the white and black photo extremes. */
export function themePng(rgb = [255, 255, 255]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const content = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(content) >>> 0);
    return Buffer.concat([length, content, crc]);
  };
  const width = 24, height = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (let c = 0; c < 3; c++) pixels[y * (1 + width * 3) + 1 + x * 3 + c] = rgb[c];
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function getTheme(request) {
  return themeJson(await request.get(BASE + "/api/account/theme"), "read saved theme");
}

export async function putTheme(request, theme) {
  return themeJson(await request.put(BASE + "/api/account/theme", { data: theme }), "save fixture theme");
}

export async function setThemeBrand(request, fixture, color) {
  const wheel = { ...fixture.wheel, brandColor: color };
  const saved = await themeJson(await request.put(BASE + "/api/wheel", { data: { wheel } }), "set own fixture brand");
  fixture.wheel = saved.wheel;
}

export async function themeFixture(request, name = "Theme") {
  const suffix = `${Date.now().toString(36)}-${++fixtureNumber}`;
  const initial = await getTheme(request);
  const original = await themeJson(await request.get(BASE + "/api/wheel"), "read original wheel");
  const fixture = { suffix, initial, originalWheel: original.wheel, photoIds: new Set(), slug: `theme-${suffix}` };
  try {
    const created = await themeJson(await request.post(BASE + "/api/wheels", { data: { name: `${name} ${suffix}` } }), "create theme fixture wheel");
    fixture.wheel = created.wheel;
    const wheel = {
      ...created.wheel, title: "Your themed wheel", brandColor: "#ec4899",
      prizes: ["Thank-you note", "A friendly message", "A shout-out"].map((label, index) => ({
        id: `theme-${suffix}-${index}`, label, rarity: "common", weight: 1, color: "#94a3b8", stock: null,
      })),
    };
    fixture.wheel = (await themeJson(await request.put(BASE + "/api/wheel", { data: { wheel } }), "seed theme fixture wheel")).wheel;
    // A fresh schedule ensures the public page resolves this own wheel even
    // when another journey left a scheduled wheel in the demo account.
    await themeJson(await request.patch(`${BASE}/api/wheels/${fixture.wheel.id}`, {
      data: { activeFrom: new Date(Date.now() - 1000).toISOString(), activeUntil: null },
    }), "activate theme fixture wheel");
    const pass = await themeJson(await request.post(BASE + "/api/passes", {
      data: { name: `${name} fan ${suffix}`, spins: 3, wheelId: fixture.wheel.id },
    }), "create theme fixture fan");
    fixture.token = pass.token; fixture.fanId = pass.fanId;
    await themeJson(await request.post(BASE + "/api/fans/ack", { data: { token: fixture.token } }), "acknowledge theme fixture fan");
    return fixture;
  } catch (error) {
    await cleanupThemeFixture(request, fixture);
    throw error;
  }
}

export async function cleanupThemeFixture(request, fixture) {
  if (!fixture) return;
  const failures = [];
  const attempt = async (name, task) => { try { await task(); } catch { failures.push(name); } };
  for (const id of fixture.photoIds) await attempt("photo", async () => {
    const result = await request.delete(`${BASE}/api/account/media/${id}`);
    // A tested creator/admin removal may already have deleted this exact id.
    if (result.status() !== 404) await themeJson(result, "remove own theme fixture photo");
  });
  await attempt("theme", () => putTheme(request, fixture.initial.theme));
  if (fixture.fanId) await attempt("fan", async () => themeJson(await request.delete(`${BASE}/api/fans/${fixture.fanId}`), "remove own theme fixture fan"));
  if (fixture.wheel?.id) await attempt("wheel", async () => themeJson(await request.delete(`${BASE}/api/wheels/${fixture.wheel.id}?hard=1`), "remove own theme fixture wheel"));
  if (failures.length) throw new Error(`theme fixture cleanup failed: ${failures.join(", ")}`);
}

/** API setup for independent axe states; real decoding and storage are exercised. */
export async function seedThemePhoto(request, fixture, caption = "A bright gallery photo", rgb) {
  const options = { multipart: { file: { name: "theme.png", mimeType: "image/png", buffer: themePng(rgb) }, caption, sfw: "yes" } };
  let response = await request.post(BASE + "/api/account/media", options);
  if (response.status() === 429) {
    const seconds = Number(response.headers()["retry-after"]);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error("media fixture received an invalid rate-limit retry window");
    // Respect the existing 10/min account limit across e2e then axe on the
    // same server. This is a bounded retry of setup, never a bypass or skip.
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.ceil(seconds * 1000) + 100)));
    response = await request.post(BASE + "/api/account/media", options);
  }
  const result = await themeJson(response, "upload own theme fixture photo");
  if (!result.media?.id) throw new Error("uploaded theme fixture did not return its media id");
  fixture.photoIds.add(result.media.id);
  return result.media;
}

export async function openLookSettings(page) {
  await goto(page, "/dashboard?section=settings", 500);
  const card = page.getByTestId("look-and-feel-card");
  await card.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("[data-testid='look-and-feel-card']")?.getAttribute("aria-busy") === "false", null, { timeout: 10000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

export async function themeAction(page, path, method, action) {
  const pending = page.waitForResponse((response) => response.url().endsWith(path) && response.request().method() === method, { timeout: 15000 });
  pending.catch(() => {});
  await action();
  const body = await themeJson(await pending, "save theme from browser");
  await page.waitForFunction(() => document.querySelector("[data-testid='look-and-feel-card']")?.getAttribute("aria-busy") === "false", null, { timeout: 10000 });
  return body;
}

export async function chooseThemeInSettings(page, { font, background, bgMediaId }) {
  const card = page.getByTestId("look-and-feel-card");
  if (font) await card.getByTestId(`theme-font-${font}`).locator("..").click();
  if (background) await card.getByTestId(`theme-background-${background}`).locator("..").click();
  if (bgMediaId) await card.getByTestId("theme-background-photo-select").selectOption(bgMediaId);
  return themeAction(page, "/api/account/theme", "PUT", () => card.getByTestId("theme-save").click());
}

export async function openAdminPhotoControl(page) {
  const admin = await themeJson(await page.request.get(BASE + "/api/admin"), "load demo admin accounts");
  const owner = admin.accounts?.find((account) => account.id === "acc-you");
  if (!owner) throw new Error("the demo hub owner's admin row is absent");
  await goto(page, "/dashboard?section=admin", 500);
  // Keep the row anchored to an unchanged owner control: the disclosure label
  // changes Show→Hide after clicking, so its ancestor is not a stable locator.
  const row = page.getByRole("region", { name: "Creator accounts", exact: true }).getByRole("listitem").filter({
    has: page.getByRole("button", { name: `Delete ${owner.displayName}`, exact: true }),
  });
  const toggle = row.getByRole("button", { name: `Show role and features for ${owner.displayName}`, exact: true })
    .or(row.getByRole("button", { name: `Hide role and features for ${owner.displayName}`, exact: true }));
  await toggle.waitFor({ timeout: 10000 });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const control = row.getByTestId("admin-remove-photos");
  await control.waitFor({ timeout: 5000 });
  return control;
}

async function noOverflow(page, assert, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `${name}: no horizontal overflow (${overflow}px)`);
}

async function fontFamily(page) {
  await page.evaluate(() => document.fonts.ready);
  return page.locator("main h1").first().evaluate((element) => getComputedStyle(element).fontFamily);
}

export async function themingJourney(page, { step, assert }, ctx) {
  let fixture;
  let photos = [];
  const viewport = page.viewportSize();
  try {
    await step("theming: own fixture and creator appearance controls load", async () => {
      fixture = await themeFixture(ctx.request);
      assert(fixture.initial.media.length === 0, "fresh demo gallery is empty before this journey's uploads");
      const card = await openLookSettings(page);
      assert(await card.getByRole("radio").count() === 12, "six fonts and six backgrounds are offered");
      assert(await card.getByTestId("theme-background-photo-select").count() === 0, "a photo selector is not offered before choosing a photo background");
      assert(/public/.test(await card.innerText()) && /safe-for-work/.test(await card.innerText()), "photo visibility and content requirements are explained before upload");
    });

    await step("theming: all six saved fonts reach the real public headline", async () => {
      for (const [font, family] of THEME_FONT_CASES) {
        const card = await openLookSettings(page);
        const saved = await chooseThemeInSettings(page, { font });
        assert(saved.theme.font === font, `${font}: server accepted the selected key`);
        assert(await card.getByTestId(`theme-font-${font}`).isChecked(), `${font}: native radio selection persists`);
        assert(await page.getByTestId("theme-preview").getAttribute("data-theme-font") === font, `${font}: live preview agrees`);
        await goto(page, `/c/${fixture.slug}-${font}`, 300);
        const familyUsed = (await fontFamily(page)).replace(/[^a-z]/gi, "").toLowerCase();
        assert(familyUsed.includes(family.replace(/[^a-z]/gi, "").toLowerCase()), `${font}: actual headline font is ${familyUsed}`);
        const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
        assert(/geist/i.test(bodyFont), "body text keeps Geist rather than the headline font");
      }
    });

    await step("theming: five preset backgrounds save and render on fan links", async () => {
      for (const background of THEME_PRESETS) {
        await openLookSettings(page);
        const result = await chooseThemeInSettings(page, { font: "syne", background });
        assert(result.theme.background === background, `${background}: saved by the server`);
        await goto(page, `/spin/${fixture.token}`, 300);
        const main = page.locator("main[data-theme-background]");
        assert(await main.getAttribute("data-theme-background") === background, `${background}: fan page uses the saved background`);
        assert((await fontFamily(page)).toLowerCase().includes("syne"), "fan headline uses the chosen font too");
        assert(await page.getByTestId("theme-backdrop").count() === 1, "one shared backdrop renders");
      }
    });

    await step("theming: client size guard and server SFW/image refusals preserve the gallery", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const card = await openLookSettings(page);
      await card.getByTestId("theme-photo-file").setInputFiles({ name: "too-large.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
      assert(/smaller than 5 MB/.test(await card.getByTestId("theme-error").innerText()), "oversize input gets a readable client refusal");
      await card.getByTestId("theme-photo-file").setInputFiles({ name: "valid.png", mimeType: "image/png", buffer: themePng() });
      assert(await card.getByTestId("theme-photo-upload").isDisabled(), "upload waits for an explicit SFW attestation");
      const noAttestation = await ctx.request.post(BASE + "/api/account/media", { multipart: { file: { name: "valid.png", mimeType: "image/png", buffer: themePng() } } });
      assert(noAttestation.status() === 400 && (await noAttestation.json()).error === "sfw_required", "the server independently refuses a missing attestation");
      const svg = await ctx.request.post(BASE + "/api/account/media", { multipart: { file: { name: "spoof.jpg", mimeType: "image/jpeg", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }, sfw: "yes" } });
      assert(svg.status() === 400 && (await svg.json()).error === "not_image", "SVG disguised as JPEG is refused by the real upload path");
      assert((await getTheme(ctx.request)).media.length === 0, "refused uploads created no gallery rows");
    });

    await step("theming: phone upload stores clean WebP, descriptions and per-photo consent", async () => {
      const card = page.getByTestId("look-and-feel-card");
      for (const [caption, rgb] of [["Bright sky fixture", [255, 255, 255]], ["Night sky fixture", [0, 0, 0]], ["Blue sky fixture", [30, 80, 170]]]) {
        await card.getByTestId("theme-photo-file").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: themePng(rgb) });
        await card.getByTestId("theme-photo-caption").fill(caption);
        await card.getByTestId("theme-photo-sfw").check();
        const body = await themeAction(page, "/api/account/media", "POST", () => card.getByTestId("theme-photo-upload").click());
        fixture.photoIds.add(body.media.id); photos.push(body.media);
        assert(!(await card.getByTestId("theme-photo-sfw").isChecked()), "each upload resets the attestation");
        assert(await card.getByTestId("theme-photo-caption").inputValue() === "", "upload clears the caption draft");
        const image = await ctx.request.get(new URL(body.media.url, BASE).href);
        const bytes = await image.body();
        assert(image.ok() && /image\/webp/.test(image.headers()["content-type"] ?? ""), "the returned photo URL serves WebP");
        assert(bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP", "stored bytes are a genuine WebP container");
      }
      assert(await card.getByTestId("theme-photo-item").count() === 3, "all uploaded photos appear in the editor");
      await noOverflow(page, assert, "390px photo editor");
    });

    await step("theming: photo background and gallery render publicly with keyboard scrolling", async () => {
      await chooseThemeInSettings(page, { background: "photo", bgMediaId: photos[0].id });
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        for (const [surface, path] of [["public", `/c/${fixture.slug}-photo-${width}`], ["fan", `/spin/${fixture.token}`]]) {
          await goto(page, path, 300);
          await page.getByTestId("theme-photo").waitFor({ timeout: 5000 });
          const gallery = page.getByTestId("photo-gallery");
          assert(await gallery.locator("img").count() === 3, `${surface}: gallery has all three photos`);
          assert(await gallery.getByAltText("Bright sky fixture", { exact: true }).count() === 1, "the creator's description is the image alternative");
          await page.waitForFunction(() => [...document.querySelectorAll("[data-testid='photo-gallery'] img, [data-testid='theme-photo']")].every((image) => image.complete && image.naturalWidth > 0), null, { timeout: 8000 });
          await noOverflow(page, assert, `${surface} ${width}px`);
          if (width === 360) {
            const strip = gallery.getByRole("list");
            await strip.focus();
            const before = await strip.evaluate((element) => element.scrollLeft);
            await page.keyboard.press("ArrowRight");
            await page.waitForTimeout(250);
            assert(await strip.evaluate((element) => element.scrollLeft) > before, "the focusable gallery scrolls with the keyboard");
          }
          ensureArtifacts(); mkdirSync(join(ARTIFACTS, "theming"), { recursive: true });
          await page.screenshot({ path: join(ARTIFACTS, "theming", `${surface}-${width}.png`), fullPage: true });
        }
      }
    });

    await step("theming: phone descriptions and keyboard reorder persist", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const card = await openLookSettings(page);
      const row = card.locator(`[data-media-id='${photos[1].id}']`);
      await row.getByRole("textbox", { name: "Caption and image description", exact: true }).fill("A dark night sky");
      await themeAction(page, `/api/account/media/${photos[1].id}`, "PATCH", () => row.getByRole("button", { name: "Save description", exact: true }).click());
      assert((await getTheme(ctx.request)).media.find((photo) => photo.id === photos[1].id).caption === "A dark night sky", "description persisted");
      const earlier = card.locator(`[data-media-id='${photos[2].id}']`).getByRole("button", { name: "Move photo 3 earlier", exact: true });
      await earlier.focus();
      await themeAction(page, "/api/account/media", "PATCH", () => page.keyboard.press("Enter"));
      const order = (await getTheme(ctx.request)).media.map((photo) => photo.id);
      assert(order.join() === [photos[0].id, photos[2].id, photos[1].id].join(), "keyboard move saved the exact new order");
      await noOverflow(page, assert, "390px gallery controls");
    });

    await step("theming: removing the background photo requires confirmation and restores Glow", async () => {
      const card = page.getByTestId("look-and-feel-card");
      const row = card.locator(`[data-media-id='${photos[0].id}']`);
      await row.getByRole("button", { name: "Remove photo", exact: true }).click();
      assert((await getTheme(ctx.request)).media.some((photo) => photo.id === photos[0].id), "opening confirmation does not delete anything");
      await themeAction(page, `/api/account/media/${photos[0].id}`, "DELETE", () => row.getByRole("button", { name: "Remove permanently", exact: true }).click());
      const saved = await getTheme(ctx.request);
      assert(!saved.media.some((photo) => photo.id === photos[0].id) && saved.theme.background === "glow", "background removal persists the fallback");
      assert(await card.getByTestId("theme-background-glow").isChecked(), "the editor agrees with the persisted fallback");
      assert(await page.getByTestId("theme-preview").getAttribute("data-theme-background") === "glow", "the live preview falls back too");
    });

    await step("theming: a malformed settings read is refused and reload recovers", async () => {
      await page.route("**/api/account/theme", (route) => route.request().method() === "GET"
        ? route.fulfill({ status: 200, json: { theme: null } }) : route.continue());
      try {
        const card = await openLookSettings(page);
        await card.getByTestId("theme-error").waitFor({ timeout: 5000 });
        assert(await card.getByRole("radio").count() === 0, "an unreadable response never becomes editable defaults");
      } finally { await page.unroute("**/api/account/theme"); }
      await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
      await page.getByTestId("theme-font-syne").waitFor({ timeout: 5000 });
      assert(await page.getByTestId("theme-font-syne").isChecked(), "reload recovers the server's saved appearance");
    });

    await step("theming: admin photo removal is scoped, confirmed and resets the background", async () => {
      const before = await getTheme(ctx.request);
      const other = await themeJson(await ctx.request.post(BASE + "/api/admin/account/media", { data: { id: "acc-bella" } }), "moderate another demo account");
      assert(other.removed === 0 && (await getTheme(ctx.request)).media.length === before.media.length, "another demo account cannot remove this creator's photos");
      const unknown = await ctx.request.post(BASE + "/api/admin/account/media", { data: { id: "acc-unknown" } });
      assert(unknown.status() === 404, "an unknown demo account cannot touch the hub");
      await putTheme(ctx.request, { font: "syne", background: "photo", bgMediaId: photos[1].id });
      const control = await openAdminPhotoControl(page);
      await control.getByRole("button", { name: "Remove photos", exact: true }).click();
      assert((await getTheme(ctx.request)).media.length === 2, "confirmation alone preserves both photos");
      const pending = page.waitForResponse((response) => response.url().endsWith("/api/admin/account/media") && response.request().method() === "POST");
      pending.catch(() => {});
      await control.getByRole("button", { name: "Confirm remove all photos", exact: true }).click();
      const body = await themeJson(await pending, "confirm admin media removal");
      assert(body.removed === 2, "the real moderation request removed exactly the own hub's photos");
      const after = await getTheme(ctx.request);
      assert(after.media.length === 0 && after.theme.background === "glow", "admin removal leaves no gallery and resets photo background");
    });
  } finally {
    await page.unroute("**/api/account/theme").catch(() => {});
    if (viewport) await page.setViewportSize(viewport);
    await step("theming: own fixtures removed and previous creator appearance restored", async () => {
      await cleanupThemeFixture(ctx.request, fixture);
      if (fixture) {
        const restored = await getTheme(ctx.request);
        assert(JSON.stringify(restored.theme) === JSON.stringify(fixture.initial.theme), "initial theme restored");
        assert(restored.media.map((photo) => photo.id).join() === fixture.initial.media.map((photo) => photo.id).join(), "initial photo ids restored without clearing unrelated data");
        const original = await themeJson(await ctx.request.get(`${BASE}/api/wheels/${fixture.originalWheel.id}`), "read original wheel after theming");
        assert(original.wheel.brandColor === fixture.originalWheel.brandColor, "other wheel's brand color stayed unchanged");
      }
    });
  }
}
