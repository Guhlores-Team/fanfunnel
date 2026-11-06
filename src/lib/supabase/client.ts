import { createBrowserClient } from "@supabase/ssr";
import { supabaseUrl } from "./url";
import { sessionCookieOptions } from "./cookies";

/** Browser-side Supabase client for use in Client Components. */
export function createClient() {
  return createBrowserClient(
    supabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Same attributes the server writes; see cookies.ts for why not httpOnly.
      cookieOptions: sessionCookieOptions(
        typeof window === "undefined" ? undefined : window.location.protocol
      ),
    }
  );
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
