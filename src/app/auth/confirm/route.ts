import { completeAuthLink } from "@/lib/auth/authLink";

// Target of every e-mail template link: {{ .SiteURL }}/auth/confirm with
// `token_hash` + `type` + a fixed `next` (never built from .RedirectTo; see
// supabase/templates/README.md). Verified server-side, so it works in any browser.
export async function GET(req: Request) {
  return completeAuthLink(req);
}
