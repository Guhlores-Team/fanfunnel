import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * The three env vars the real (non-mock) Supabase path needs. The service-role
 * key matters as much as the public pair: the fan spin path uses
 * `createServiceClient()`, so a deploy with URL+anon but no service key would
 * NOT fall back to mock — it would hit Supabase with an `undefined` key and
 * break every spin at runtime. We treat all three as required together.
 */
function missingSupabaseEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}

/**
 * True production runtime. We key off Vercel's `VERCEL_ENV` (set to
 * "production" only for production deploys) rather than `NODE_ENV` so that
 * `next build`, local runs, and the intentional in-memory demo keep working in
 * mock mode. Self-hosted production can opt in with `FF_REQUIRE_SUPABASE=1`.
 */
function isProductionRuntime(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    process.env.FF_REQUIRE_SUPABASE === "1"
  );
}

/**
 * Whether to use the real Supabase backend (vs the in-memory mock store).
 *
 * Fails CLOSED in production: if any required env var is missing on a real
 * production deploy we throw a clear error instead of silently serving fake,
 * cold-start-wiped in-memory data (and instead of running the privileged spin
 * path with an undefined service-role key). Locally / in preview, a missing
 * config simply means "run the demo in mock mode".
 */
export function isSupabaseConfigured(): boolean {
  const missing = missingSupabaseEnv();
  if (missing.length === 0) return true;
  if (isProductionRuntime()) {
    throw new Error(
      `FanFunnel is misconfigured: missing required env var(s) in production: ` +
        `${missing.join(", ")}. Refusing to start in demo/mock mode. Set these in ` +
        `your hosting provider's project settings (Supabase → Project Settings → API).`
    );
  }
  return false;
}

/**
 * Server-side Supabase client bound to the request's auth cookies.
 * Use in Server Components, Route Handlers, and Server Actions.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — safe to ignore; middleware
            // refreshes the session.
          }
        },
      },
    }
  );
}

/**
 * Privileged client using the service-role key. Bypasses Row Level Security.
 * ONLY use server-side for trusted operations like recording a spin where we
 * must atomically decrement spins and stock regardless of the caller.
 */
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
