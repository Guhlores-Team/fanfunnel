import assert from "node:assert";
import { sniffImageMime, EXT_BY_MIME } from "./imageSniff";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const bytes = (...b: number[]) => Uint8Array.from(b);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

// Real magic bytes are detected.
check("jpeg", sniffImageMime(bytes(0xff, 0xd8, 0xff, 0x00)) === "image/jpeg");
check(
  "png",
  sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)) === "image/png",
);
check("gif87a", sniffImageMime(ascii("GIF87a---")) === "image/gif");
check("gif89a", sniffImageMime(ascii("GIF89a---")) === "image/gif");
check("webp", sniffImageMime(ascii("RIFF    WEBPVP8 ")) === "image/webp");

// Anything else is rejected.
check("svg rejected", sniffImageMime(ascii("<svg xmlns=...>")) === null);
check("html rejected", sniffImageMime(ascii("<!DOCTYPE html>")) === null);
check("empty rejected", sniffImageMime(bytes()) === null);
check("truncated jpeg rejected", sniffImageMime(bytes(0xff, 0xd8)) === null);
check("riff-but-not-webp rejected", sniffImageMime(ascii("RIFF    AVI ....")) === null);

// Photo hub (per-creator theming): SVG in every disguise is still refused, and
// an XML/SVG document is never mistaken for a raster image.
check("svg behind a UTF-8 BOM rejected", sniffImageMime(bytes(0xef, 0xbb, 0xbf, ...ascii("<svg/>"))) === null);
check("svg behind whitespace rejected", sniffImageMime(ascii("\n  <svg xmlns='http://www.w3.org/2000/svg'/>")) === null);
check("xml prolog + svg rejected", sniffImageMime(ascii('<?xml version="1.0"?><svg/>')) === null);
check("gzipped svg (svgz) rejected", sniffImageMime(bytes(0x1f, 0x8b, 0x08, 0x00)) === null);
check("riff-webp lookalike with an svg body still only reads as webp by magic", sniffImageMime(ascii("RIFF    WEBP<svg/>")) === "image/webp");

// Every detected MIME maps to an extension.
check(
  "every mime has an extension",
  (["image/jpeg", "image/png", "image/gif", "image/webp"] as const).every((m) => !!EXT_BY_MIME[m]),
);

console.log(`imageSniff.test: ${passed} checks passed`);
