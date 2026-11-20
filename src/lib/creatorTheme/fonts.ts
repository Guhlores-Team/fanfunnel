// The six headline fonts a creator can pick (owner list; config.ts keys).
//
// Declared with next/font/google, so the files are downloaded at BUILD time and
// served from this app: a fan's browser never calls Google, and no creator can
// point the page at an arbitrary font URL. `preload: false` keeps every page
// from fetching all six: the @font-face rules are tiny, and a browser only
// downloads the font file a rendered element actually uses (the chosen one).
// Bricolage Grotesque is the app's display face, already loaded by the root
// layout as --ff-display, so choosing it changes nothing.

import { DM_Serif_Display, Fraunces, Playfair_Display, Syne, Unbounded } from "next/font/google";
import type { ThemeFont } from "./config";

const playfair = Playfair_Display({ subsets: ["latin"], weight: ["700", "800"], display: "swap", preload: false });
const dmSerif = DM_Serif_Display({ subsets: ["latin"], weight: "400", display: "swap", preload: false });
const syne = Syne({ subsets: ["latin"], weight: ["700", "800"], display: "swap", preload: false });
const fraunces = Fraunces({ subsets: ["latin"], weight: ["700", "800"], display: "swap", preload: false });
const unbounded = Unbounded({ subsets: ["latin"], weight: ["700", "800"], display: "swap", preload: false });

/** The CSS font-family for a theme font, or null for the app default (Bricolage). */
export function themeFontFamily(font: ThemeFont): string | null {
  switch (font) {
    case "playfair":
      return playfair.style.fontFamily;
    case "dm-serif":
      return dmSerif.style.fontFamily;
    case "syne":
      return syne.style.fontFamily;
    case "fraunces":
      return fraunces.style.fontFamily;
    case "unbounded":
      return unbounded.style.fontFamily;
    default:
      return null;
  }
}
