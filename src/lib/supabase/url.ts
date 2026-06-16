/**
 * The Supabase project URL, normalized to its ORIGIN.
 *
 * Supabase's dashboard surfaces several URLs (the bare project URL, the Data
 * API/REST endpoint `…/rest/v1/`, etc.) and it's easy to paste the wrong one,
 * or to leave a trailing slash, into NEXT_PUBLIC_SUPABASE_URL. The auth/storage
 * clients build their own paths off this value, so a stray path/slash breaks
 * sign-in. Stripping to the origin makes the app tolerant of that mistake.
 */
export function supabaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}
