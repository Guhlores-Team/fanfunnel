import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every Supabase Auth call that emails the user a link must say where that
// link returns. Without it Supabase falls back to the project's Site URL —
// localhost:3000 on the test project — and the link opens a dead page (seen
// on the Preview for email change and sign-up confirmation).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(e) && !e.endsWith(".test.ts") ? [p] : [];
  });
}

// call → the option that carries the return address
const EMAILING_CALLS: [RegExp, RegExp][] = [
  [/\.auth\.signUp\(/, /emailRedirectTo/],
  [/\.auth\.signInWithOtp\(/, /emailRedirectTo/],
  [/\.auth\.resetPasswordForEmail\(/, /redirectTo/],
  [/\.auth\.updateUser\(\{\s*email\b/, /emailRedirectTo/],
  [/\.auth\.resend\(/, /emailRedirectTo/],
];

let calls = 0;
for (const file of files("src")) {
  const src = readFileSync(file, "utf8");
  for (const [call, redirect] of EMAILING_CALLS) {
    for (const m of src.matchAll(new RegExp(call, "g"))) {
      calls++;
      // The call's own argument list (generous window, stops at the statement end).
      const window = src.slice(m.index, m.index + 600).split(/\);\s*\n/)[0];
      check(`${file}: ${m[0]} passes ${redirect.source}`, redirect.test(window));
    }
  }
}
check("the scan found the known emailing calls", calls >= 3);

console.log(`✅ email redirects: ${passed} checks passed (${calls} emailing auth calls)`);
