// Server-side re-encoding of a photo-hub upload (per-creator theming).
//
// Every upload is decoded and re-encoded, never stored as sent:
//   1. size cap, then the magic-byte sniff the avatar route uses (raster only;
//      SVG, HTML and anything spoofed are refused before decoding);
//   2. sharp decodes it with a pixel limit (decompression bombs fail fast) and
//      must agree with the sniffed format;
//   3. it is auto-rotated, shrunk to at most MAX_EDGE_PX, and written as a
//      fresh WebP. sharp drops ALL metadata by default (EXIF incl. GPS, XMP,
//      IPTC, ICC), so a photo's location can't leak a creator's home, and
//      bytes appended to the file (a polyglot payload) don't survive.
// The output is always image/webp; nothing about it comes from the input bytes
// except the pixels.
//
// Imported only by server code (the data layer behind the upload route).

import "server-only";
import sharp from "sharp";
import { sniffImageMime } from "@/lib/api/imageSniff";
import { MAX_EDGE_PX, MAX_INPUT_PIXELS, MAX_STORED_BYTES, MAX_UPLOAD_BYTES, WEBP_QUALITY } from "./config";

export type ProcessImageError = "no_file" | "too_large" | "not_image";
export interface ProcessedImage {
  webp: Buffer;
  width: number;
  height: number;
}

const FORMAT_BY_MIME = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export async function processUpload(bytes: Uint8Array): Promise<ProcessedImage | { error: ProcessImageError }> {
  if (bytes.byteLength === 0) return { error: "no_file" };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { error: "too_large" };
  const mime = sniffImageMime(bytes);
  if (!mime) return { error: "not_image" };
  try {
    const input = () =>
      sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false });
    const meta = await input().metadata();
    if (meta.format !== FORMAT_BY_MIME[mime]) return { error: "not_image" };
    for (const quality of [WEBP_QUALITY, 65, 50]) {
      const { data, info } = await input()
        .rotate()
        .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
      if (data.byteLength <= MAX_STORED_BYTES) return { webp: data, width: info.width, height: info.height };
    }
    return { error: "too_large" };
  } catch {
    return { error: "not_image" };
  }
}
