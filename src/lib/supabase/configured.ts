/**
 * Whether the public Supabase settings are present. Kept apart from
 * ./client so a component that only needs this check (the debug console,
 * mounted on every page of a debug build) doesn't pull the Supabase client
 * library into every page's bundle.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
