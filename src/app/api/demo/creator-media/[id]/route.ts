import { isSupabaseConfigured } from "@/lib/supabase/server";
import { mockGetMedia } from "@/lib/data/mockTheme";

// Demo mode only: serves the in-memory photo hub (the re-encoded WebP bytes),
// so the demo and e2e exercise the same upload path as Supabase. With Supabase
// configured, photos come from the public `creator-media` bucket instead and
// this route does not exist (404).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (isSupabaseConfigured()) return notFound();
  const { id } = await ctx.params;
  const m = mockGetMedia(id);
  if (!m) return notFound();
  return new Response(new Uint8Array(m.webp), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
