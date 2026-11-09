// Names the Supabase project a build talks to, so a tester can tell at a glance
// whether a Preview is on the TEST database (expected) or, by misconfiguration,
// on the LIVE one. Project refs are public (they are in every browser request).
export const SUPABASE_PROJECTS = {
  snmcrmhgevfqggxdiomu: "TEST",
  ttlogfmogcccwiraaoae: "LIVE",
} as const;

export type EnvLabel = { text: string; tone: "ok" | "danger" | "neutral" };

export function supabaseRef(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec((url ?? "").trim());
  return m ? m[1] : null;
}

export function envLabel(url: string | undefined): EnvLabel {
  if (!url) return { text: "PREVIEW · demo data (no database)", tone: "neutral" };
  const ref = supabaseRef(url);
  const name = ref ? SUPABASE_PROJECTS[ref as keyof typeof SUPABASE_PROJECTS] : undefined;
  if (name === "TEST") return { text: "PREVIEW · TEST database", tone: "ok" };
  if (name === "LIVE") return { text: "PREVIEW · ⚠ LIVE DATABASE ⚠", tone: "danger" };
  return { text: `PREVIEW · unknown database (${ref ?? "unrecognised URL"})`, tone: "danger" };
}

/**
 * OPS-13: the short commit this build came from, so a "tested on Preview"
 * sign-off names a commit. Vercel Git deploys set VERCEL_GIT_COMMIT_SHA; CLI
 * archive deploys pass NEXT_PUBLIC_COMMIT_SHA (docs/PREVIEW_DEPLOY.md).
 */
export function shortCommit(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.VERCEL_GIT_COMMIT_SHA || env.NEXT_PUBLIC_COMMIT_SHA || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 7).toLowerCase() : "unknown";
}
