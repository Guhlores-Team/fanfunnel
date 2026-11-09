import { completeAuthLink } from "@/lib/auth/authLink";

// Target of the e-mail templates' fallback link ({{ .SiteURL }}/auth/confirm,
// used when Supabase sends no redirect, e.g. from its own dashboard):
// `token_hash` + `type` verified server-side, so it works in any browser.
export async function GET(req: Request) {
  return completeAuthLink(req);
}
