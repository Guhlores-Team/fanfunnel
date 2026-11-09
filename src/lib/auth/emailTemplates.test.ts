import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// C1: the auth e-mail templates link with {{ .TokenHash }} so a link works in
// any browser. A1 (batch 6): the link is built from {{ .SiteURL }} with a fixed
// `next` per template, never from {{ .RedirectTo }}: that value is chosen by
// whoever calls the public /recover or /otp endpoint, so a loose Redirect URL
// allow-list would hand the victim's token_hash to an outside host.

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

function templateLinkProblems(html: string, type: string, next: string): string[] {
  const problems: string[] = [];
  if (html.includes(".ConfirmationURL")) problems.push("uses the PKCE-only ConfirmationURL");
  if (/\.RedirectTo\b/.test(html)) problems.push("references .RedirectTo");
  const want = `{{ $link := printf "%s/auth/confirm?token_hash=%s&type=${type}&next=${next}" .SiteURL .TokenHash }}`;
  if (!html.includes(want)) problems.push("does not build the Site URL token_hash link");
  if ((html.match(/\{\{ \$link \}\}/g) ?? []).length !== 3) problems.push("button + plain link do not all use $link");
  for (const m of html.matchAll(/href="([^"]*)"/g)) if (m[1] !== "{{ $link }}") problems.push(`extra href ${m[1]}`);
  return problems;
}

for (const [file, { type, next }] of Object.entries(LINK_TEMPLATES)) {
  const html = readFileSync(join(TEMPLATES, file), "utf8");
  const problems = templateLinkProblems(html, type, next);
  check(`${file}: ${problems.join("; ") || "ok"}`, problems.length === 0);
  check(`${file}: has the same-device fallback note`, html.includes("Open this link on the device you&rsquo;re using to sign in."));
}
// Negative: the previous (RedirectTo-based) template shape must fail the check.
const legacy =
  '{{ $base := .RedirectTo }}{{ if eq .RedirectTo .SiteURL }}{{ $base = printf "%s/auth/confirm?next=/reset-password" .SiteURL }}{{ end }}' +
  '{{ $link := printf "%s&token_hash=%s&type=recovery" $base .TokenHash }}<a href="{{ $link }}">{{ $link }}</a><a href="{{ $link }}"></a>';
check("a template that references .RedirectTo fails", templateLinkProblems(legacy, "recovery", "/reset-password").includes("references .RedirectTo"));
const good = '{{ $link := printf "%s/auth/confirm?token_hash=%s&type=recovery&next=/reset-password" .SiteURL .TokenHash }}<a href="{{ $link }}">{{ $link }}</a><a href="{{ $link }}"></a>';
check("the Site URL shape passes", templateLinkProblems(good, "recovery", "/reset-password").length === 0);
check("an extra .RedirectTo href fails", templateLinkProblems(good + '<a href="{{ .RedirectTo }}">x</a>', "recovery", "/reset-password").length > 0);
check("the confirmation e-mail mentions the approval step", readFileSync(join(TEMPLATES, "confirmation.html"), "utf8").includes("approved by hand"));
check("the README no longer says there is no MFA", !/no\s+phone auth, linked identities or MFA/.test(readFileSync(join(TEMPLATES, "README.md"), "utf8")));

// The app still passes redirectTo/emailRedirectTo (Supabase only uses it for the
// legacy {{ .ConfirmationURL }} links and to pick the post-verify page); the
// templates ignore it. Keep each one on this site's callback with a `?next=`.
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
