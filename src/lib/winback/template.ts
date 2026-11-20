// Fill a saved DM template for one fan. Plain text in, plain text out: the
// result is copied to the clipboard for the creator to paste into their own
// DMs, and is only ever rendered as React text (escaped), never as HTML.

/** The tokens a template may use, in the order the template editor lists them. */
export const TEMPLATE_TOKENS = ["{name}", "{link}", "{lastWin}", "{days}", "{creator}"] as const;

export interface TemplateValues {
  /** The fan's display name. */
  name?: string | null;
  /** The fan's full spin URL. */
  link?: string | null;
  /** The label of the fan's last win. */
  lastWin?: string | null;
  /** Days since the fan last played. */
  days?: number | null;
  /** The creator's display name. */
  creator?: string | null;
}

const TOKEN_RE = /\{(name|link|lastWin|days|creator)\}/g;

/**
 * Replace every known token in ONE pass, so a value that itself contains a
 * token (a fan named "{link}") is inserted literally and never expanded.
 * A missing value becomes an empty string; unknown `{tokens}` are left as
 * typed. Runs of spaces left by an empty value collapse to one (newlines kept).
 */
export function fillTemplate(body: string, v: TemplateValues): string {
  let blanked = false;
  const out = body.replace(TOKEN_RE, (_m, key: keyof TemplateValues) => {
    const raw = v[key];
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    if (text === "") blanked = true;
    return text;
  });
  return blanked ? out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.!?])/g, "$1") : out;
}

/** Whether a template mentions {link} (the queue warns when it doesn't). */
export function templateHasLink(body: string): boolean {
  return body.includes("{link}");
}
