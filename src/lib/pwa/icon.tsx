// Home-screen icons rendered with the built-in next/og ImageResponse (no new
// dependency). Server-only: the avatar is fetched here, never by the browser.
import "server-only";
import { ImageResponse } from "next/og";
import { readableInk } from "@/lib/theme";
import { sniffImageMime } from "@/lib/api/imageSniff";
import WheelGlyph from "./WheelGlyph";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 4000;

/**
 * Fetch an avatar (already validated by avatarSource) as a data URL, or null.
 * PNG and JPEG only: those are what the renderer reliably decodes; anything
 * else falls back to the neutral glyph instead of a broken icon.
 */
export async function loadAvatarDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > AVATAR_MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) return null;
    const mime = sniffImageMime(bytes);
    if (mime !== "image/png" && mime !== "image/jpeg") return null;
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

function iconElement(opts: { size: number; maskable: boolean; brand: string; avatar: string | null }) {
  const { size, maskable, brand, avatar } = opts;
  if (avatar) {
    return (
      <div style={{ display: "flex", width: size, height: size, background: brand }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={avatar} width={size} height={size} style={{ objectFit: "cover" }} />
      </div>
    );
  }
  // Maskable icons keep the drawing inside the central 80% safe zone.
  const glyph = Math.round(size * (maskable ? 0.58 : 0.76));
  return (
    <div
      style={{
        display: "flex",
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        background: brand,
      }}
    >
      <WheelGlyph size={glyph} ink={readableInk(brand)} />
    </div>
  );
}

/**
 * Render one icon to PNG bytes. Rendering is awaited here (not streamed), so a
 * decode failure on the avatar falls back to the glyph instead of a truncated
 * response.
 */
export async function renderAppIcon(opts: {
  size: number;
  maskable: boolean;
  brand: string;
  avatar: string | null;
}): Promise<ArrayBuffer> {
  const draw = (avatar: string | null) =>
    new ImageResponse(iconElement({ ...opts, avatar }), { width: opts.size, height: opts.size }).arrayBuffer();
  if (opts.avatar) {
    try {
      return await draw(opts.avatar);
    } catch {
      /* fall through to the neutral glyph */
    }
  }
  return draw(null);
}
