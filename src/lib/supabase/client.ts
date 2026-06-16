import { createBrowserClient } from "@supabase/ssr";
import { supabaseUrl } from "./url";

/** Browser-side Supabase client for use in Client Components. */
export function createClient() {
  return createBrowserClient(
    supabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
