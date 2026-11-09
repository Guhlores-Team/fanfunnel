import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// C1: the auth e-mail templates link with {{ .TokenHash }} so a link works in
// any browser, and the app's own redirects keep a `?next=` query, because the
// templates append `&token_hash=…&type=…` to {{ .RedirectTo }}.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ROOT = join(import.meta.dirname, "../../..");
const TEMPLATES = join(ROOT, "supabase/templates");
const LINK_TEMPLATES: Record<string, { type: string; next: string }> = {
  "recovery.html": { type: "recovery", next: "/reset-password" },
  "confirmation.html": { type: "email", next: "/pending" },
  "magic_link.html": { type: "email", next: "/dashboard" },
  "invite.html": { type: "invite", next: "/set-password" },
  "email_change.html": { type: "email_change", next: "/dashboard" },
};

for (const [file, { type, next }] of Object.entries(LINK_TEMPLATES)) {
  const html = readFileSync(join(TEMPLATES, file), "utf8");
  check(`${file}: no PKCE-only ConfirmationURL link left`, !html.includes(".ConfirmationURL"));
  check(`${file}: builds the token_hash link`, html.includes(`{{ $link := printf "%s&token_hash=%s&type=${type}" $base .TokenHash }}`));
  check(`${file}: falls back to /auth/confirm on the Site URL`, html.includes(`{{ $base = printf "%s/auth/confirm?next=${next}" .SiteURL }}`));
  check(`${file}: uses the app's redirect otherwise`, html.includes("{{ $base := .RedirectTo }}{{ if eq .RedirectTo .SiteURL }}"));
  check(`${file}: button + plain link both use it`, (html.match(/\{\{ \$link \}\}/g) ?? []).length === 3);
  check(`${file}: has the same-device fallback note`, html.includes("Open this link on the device you&rsquo;re using to sign in."));
}
check("the confirmation e-mail mentions the approval step", readFileSync(join(TEMPLATES, "confirmation.html"), "utf8").includes("approved by hand"));
check("the README no longer says there is no MFA", !/no\s+phone auth, linked identities or MFA/.test(readFileSync(join(TEMPLATES, "README.md"), "utf8")));

// Every redirect the app hands Supabase must carry `?next=` (the templates append with "&").
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
let redirects = 0;
for (const file of walk(join(ROOT, "src"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:redirectTo|emailRedirectTo)(?:\s*[:=]\s*|\s*\}?\s*=\s*)`([^`]*)`/g)) {
    redirects++;
    check(`${file.slice(ROOT.length + 1)}: redirect ${m[1]} keeps ?next=`, /\/auth\/(callback|confirm)\?next=\//.test(m[1]));
  }
}
check("found the app's e-mail redirects (sign-up, resend, reset, e-mail change, invite)", redirects >= 5);

console.log(`emailTemplates.test: ${passed} checks passed`);
