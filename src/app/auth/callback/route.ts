import { completeAuthLink } from "@/lib/auth/authLink";

// Auth redirect target the app passes as `redirectTo`/`emailRedirectTo`
// (password recovery, sign-up confirmation, e-mail change, admin invites).
// The current templates link to /auth/confirm instead (built from the Site URL);
// this keeps the legacy PKCE `code` links (old {{ .ConfirmationURL }}) working.
// Handles both the PKCE `code` and the `token_hash` links; see authLink.ts.
export async function GET(req: Request) {
  return completeAuthLink(req);
}
