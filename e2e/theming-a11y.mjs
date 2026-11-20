// Independent axe states: each creates its own wheel/fan/media, changes only
// the demo creator's appearance, and restores the previous state after scan.
import { goto } from "./harness.mjs";
import {
  THEME_PRESETS, cleanupThemeFixture, openAdminPhotoControl, openLookSettings,
  putTheme, seedThemePhoto, setThemeBrand, themeFixture,
} from "./theming.mjs";

const fixtures = new WeakMap();
const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 360, height: 800 };

export async function themingA11yCleanup(page) {
  await page.emulateMedia({ reducedMotion: null }).catch(() => {});
  await cleanupThemeFixture(page.request, fixtures.get(page));
  fixtures.delete(page);
}

/** `surface` chooses real fan, public, Settings or moderation UI, never mocks it. */
function prepare({ background = "glow", brand = "#ffffff", font = "syne", photo = false, photos = 0, surface = "fan", remove = false, validation = false }) {
  return async (page) => {
    const fixture = await themeFixture(page.request, "A11y theme");
    fixtures.set(page, fixture);
    try {
      await setThemeBrand(page.request, fixture, brand);
      const media = [];
      for (let i = 0; i < Math.max(photos, photo ? 1 : 0); i++) {
        media.push(await seedThemePhoto(page.request, fixture, ["A bright sky", "A dark night", "A blue horizon"][i] ?? `Gallery photo ${i + 1}`, i === 1 || photo === "black" ? [0, 0, 0] : i === 2 ? [30, 80, 170] : [255, 255, 255]));
      }
      await putTheme(page.request, { font, background: photo ? "photo" : background, bgMediaId: photo ? media[0].id : null });
      if (surface === "settings") {
        const card = await openLookSettings(page);
        if (validation) {
          await card.getByTestId("theme-photo-file").setInputFiles({ name: "too-big.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
          await card.getByTestId("theme-error").waitFor({ timeout: 5000 });
        } else if (remove) {
          await card.getByTestId("theme-photo-item").first().getByRole("button", { name: "Remove photo", exact: true }).click();
          await card.getByRole("button", { name: "Remove permanently", exact: true }).scrollIntoViewIfNeeded();
        }
      } else if (surface === "admin") {
        const control = await openAdminPhotoControl(page);
        await control.getByRole("button", { name: "Remove photos", exact: true }).click();
        await control.scrollIntoViewIfNeeded();
      } else {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await goto(page, surface === "public" ? `/c/${fixture.slug}-axe` : `/spin/${fixture.token}`, 400);
        await page.locator(`main[data-theme-background='${photo ? "photo" : background}']`).waitFor({ timeout: 8000 });
        if (photo) await page.getByTestId("theme-photo").waitFor({ timeout: 5000 });
        if (media.length) {
          await page.getByTestId("photo-gallery").waitFor({ timeout: 5000 });
          await page.waitForFunction(() => [...document.querySelectorAll("[data-testid='photo-gallery'] img, [data-testid='theme-photo']")].every((image) => image.complete && image.naturalWidth > 0), null, { timeout: 8000 });
        }
      }
      await page.evaluate(() => document.fonts.ready);
    } catch (error) {
      await themingA11yCleanup(page);
      throw error;
    }
  };
}

export function themingA11yStates(dashboardAdvisory = []) {
  const state = (name, options, viewport, dashboard = false) => ({
    path: null, name, prep: prepare(options), cleanup: themingA11yCleanup, context: {},
    ...(viewport ? { viewport } : {}), ...(dashboard ? { advisory: dashboardAdvisory } : {}),
  });
  return [
    ...THEME_PRESETS.map((background) => state(`fan phone (theme ${background}, white brand)`, { background }, PHONE)),
    state("fan small phone (solid, black brand, Unbounded headline)", { background: "solid", brand: "#000000", font: "unbounded" }, SMALL_PHONE),
    state("public page (aurora, white brand)", { surface: "public", background: "aurora" }),
    state("public small phone (noir, black brand)", { surface: "public", background: "noir", brand: "#000000", font: "fraunces" }, SMALL_PHONE),
    state("fan phone (white photo background)", { photo: "white" }, PHONE),
    state("fan small phone (black photo, black brand)", { photo: "black", brand: "#000000" }, SMALL_PHONE),
    state("public phone (photo background and gallery)", { surface: "public", photo: "white" }, PHONE),
    state("dashboard (Look & feel controls)", { surface: "settings" }, null, true),
    state("dashboard phone (Look & feel with three gallery photos)", { surface: "settings", photos: 3 }, PHONE, true),
    state("dashboard small phone (photo deletion confirmation)", { surface: "settings", photos: 1, remove: true }, SMALL_PHONE, true),
    state("dashboard phone (photo validation error)", { surface: "settings", validation: true }, PHONE, true),
    state("dashboard phone (admin photo removal confirmation)", { surface: "admin", photos: 1 }, PHONE, true),
  ];
}
