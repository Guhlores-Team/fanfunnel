import assert from "node:assert";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { sniffImageMime } from "@/lib/api/imageSniff";
import { MAX_EDGE_PX, MAX_UPLOAD_BYTES } from "./config";
import { processUpload } from "./processImage";

// Photo-hub uploads (per-creator theming): only real raster images get in, and
// what is stored is a fresh WebP with no metadata (no GPS), no appended
// payload, and no edge over MAX_EDGE_PX.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}
const ascii = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const hasPair = (b: Uint8Array, x: number, y: number) => {
  for (let i = 0; i + 1 < b.length; i++) if (b[i] === x && b[i + 1] === y) return true;
  return false;
};
/** A valid 1-bit greyscale PNG of w x h zero pixels, built by hand. */
function pngBomb(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([1, 0, 0, 0, 0], 8); // bit depth 1, greyscale, deflate, no filter, no interlace
  const raw = Buffer.alloc((1 + Math.ceil(w / 8)) * h); // filter byte 0 + zero pixels per row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const err = (r: Awaited<ReturnType<typeof processUpload>>) => ("error" in r ? r.error : null);

async function main() {
  // --- A phone photo with GPS + camera EXIF comes back clean ------------------
  const gpsJpeg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#3366cc" } })
    .withExif({
      IFD0: { Make: "PhoneCo", Model: "SECRET-MODEL", Copyright: "SECRET-OWNER" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" },
    })
    .jpeg()
    .toBuffer();
  const inMeta = await sharp(gpsJpeg).metadata();
  check("fixture really carries EXIF", !!inMeta.exif && inMeta.exif.includes(Buffer.from("SECRET-MODEL")));
  check("fixture really carries a GPS IFD (tag 0x8825)", hasPair(inMeta.exif!, 0x25, 0x88));

  const ok = await processUpload(new Uint8Array(gpsJpeg));
  assert.ok(!("error" in ok), "a real JPEG is accepted");
  if ("error" in ok) return;
  const outMeta = await sharp(ok.webp).metadata();
  check("output is WebP", outMeta.format === "webp" && sniffImageMime(new Uint8Array(ok.webp)) === "image/webp");
  check("output has no EXIF at all (no GPS)", !outMeta.exif);
  check("output has no XMP / IPTC / ICC", !outMeta.xmp && !outMeta.iptc && !outMeta.icc);
  check("no camera strings survive", !ok.webp.includes(Buffer.from("SECRET-MODEL")) && !ok.webp.includes(Buffer.from("SECRET-OWNER")));
  check("no Exif chunk in the file", !ok.webp.includes(Buffer.from("EXIF")) && !ok.webp.includes(Buffer.from("Exif")));
  check("longest edge capped", ok.width === MAX_EDGE_PX && ok.height === MAX_EDGE_PX / 2);
  check("reported size is the real size", outMeta.width === ok.width && outMeta.height === ok.height);

  // --- EXIF orientation is applied before the metadata is dropped -------------
  const rotated = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#00ff00" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const r = await processUpload(new Uint8Array(rotated));
  check("orientation 6 is baked in (portrait)", !("error" in r) && r.width === 20 && r.height === 40);

  // --- Small images aren't enlarged; PNG / GIF / WebP all re-encode -----------
  for (const fmt of ["png", "gif", "webp"] as const) {
    const buf = await sharp({ create: { width: 30, height: 10, channels: 4, background: "#ff00ff80" } })[fmt]().toBuffer();
    const p = await processUpload(new Uint8Array(buf));
    check(`${fmt} accepted and kept at its size`, !("error" in p) && p.width === 30 && p.height === 10);
  }

  // --- Polyglots and spoofs ----------------------------------------------------
  const tail = "<html><script>alert(document.cookie)</script></html>";
  const appended = new Uint8Array(Buffer.concat([gpsJpeg, Buffer.from(tail)]));
  const ap = await processUpload(appended);
  check("a JPEG with an appended HTML payload is re-encoded…", !("error" in ap));
  check("…and the payload is gone", !("error" in ap) && !ap.webp.includes(Buffer.from("<script>")));
  check("JPEG magic + HTML body is refused", err(await processUpload(ascii("\xff\xd8\xff\xe0" + tail.repeat(20)))) === "not_image");
  check("PNG magic + junk is refused", err(await processUpload(ascii("\x89PNG\r\n\x1a\n" + "x".repeat(200)))) === "not_image");
  check("GIF magic + SVG is refused", err(await processUpload(ascii("GIF89a<svg onload=alert(1)>"))) === "not_image");
  check("SVG is refused", err(await processUpload(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))) === "not_image");
  check("SVG behind a BOM / whitespace is refused", err(await processUpload(ascii("﻿  <svg xmlns='http://www.w3.org/2000/svg'/>"))) === "not_image");
  check("HTML is refused", err(await processUpload(ascii("<!DOCTYPE html><title>x</title>"))) === "not_image");
  // A PNG body behind JPEG magic: the decoder disagrees with the sniff.
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
  const mislabeled = new Uint8Array(png.length + 3);
  mislabeled.set([0xff, 0xd8, 0xff]);
  mislabeled.set(png, 3);
  check("a PNG wearing JPEG magic is refused", err(await processUpload(mislabeled)) === "not_image");

  // --- Size and pixel limits -----------------------------------------------------
  check("empty is refused", err(await processUpload(new Uint8Array())) === "no_file");
  const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  big.set([0xff, 0xd8, 0xff]);
  check("over 5 MB is refused before decoding", err(await processUpload(big)) === "too_large");
  // 10000x10000 = 100M pixels in a ~15 KB file that would decode huge.
  const bomb = pngBomb(10000, 10000);
  check("bomb fixture is small on disk", bomb.byteLength < MAX_UPLOAD_BYTES);
  const bombMeta = await sharp(bomb, { limitInputPixels: false }).metadata();
  check("bomb fixture is a valid 10000x10000 PNG", bombMeta.format === "png" && bombMeta.width === 10000 && bombMeta.height === 10000);
  check("a decompression bomb is refused", err(await processUpload(new Uint8Array(bomb))) === "not_image");

  console.log(`creatorTheme/processImage.test.ts: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
