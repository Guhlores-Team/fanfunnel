import { revalidatePath } from "next/cache";
import { getMyPublicProfile } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/supabase/server";

/**
 * Mark the signed-in creator's public page (`/c/<slug>`, ISR at 60s) stale so
 * fans see a change on their next visit instead of up to a minute later. The
 * page shows the creator's display name and their live wheel (prizes, brand
 * colour), so routes call this after a successful wheel save / activate /
 * schedule / archive / delete, brand-colour change or display-name change.
 *
 * Call it only after the write succeeded. It never fails the request: the
 * write is already done, and the page catches up on its own within 60s.
 */
export async function revalidateMyPublicPage(): Promise<void> {
  try {
    const { slug } = await getMyPublicProfile();
    if (slug) revalidatePath(`/c/${slug}`);
  } catch (err) {
    console.error("revalidateMyPublicPage failed", err);
  }
}

/**
 * After a theme or photo change (per-creator theming): mark the creator's
 * public page stale. In demo mode every /c/<slug> renders the demo creator, so
 * all of them are marked (the pattern form needs `type`, see revalidatePath).
 */
export async function revalidateMyThemedPublicPage(): Promise<void> {
  await revalidateMyPublicPage();
  try {
    if (!isSupabaseConfigured()) revalidatePath("/c/[slug]", "page");
  } catch (err) {
    console.error("revalidateMyThemedPublicPage failed", err);
  }
}
