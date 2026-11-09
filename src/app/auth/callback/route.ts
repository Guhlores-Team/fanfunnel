import { completeAuthLink } from "@/lib/auth/authLink";

// Auth redirect target the app passes as `redirectTo`/`emailRedirectTo`
// (password recovery, sign-up confirmation, e-mail change, admin invites).
// Handles both the PKCE `code` and the `token_hash` links; see authLink.ts.
export async function GET(req: Request) {
  return completeAuthLink(req);
}
