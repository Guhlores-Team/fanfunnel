// The access-request form folds its extra vetting fields into the
// application's `note` (no migration needed). Pure, so /pending can show and
// edit the stored request (C21) and both directions are unit-tested.

export interface ApplicationExtras {
  platform: string;
  country: string;
  referral: string;
  note: string;
}

const PREFIX: [keyof ApplicationExtras, string][] = [
  ["platform", "Main platform: "],
  ["country", "Based in: "],
  ["referral", "Heard about us: "],
  ["note", "Notes: "],
];

export function composeApplicationNote(x: ApplicationExtras): string {
  return PREFIX.filter(([k]) => x[k].trim())
    .map(([k, p]) => `${p}${x[k].trim()}`)
    .join("\n");
}

/** The fields back out of a stored note. Text before any known prefix (an
 *  older or hand-written note) is kept as the free-text note. */
export function parseApplicationNote(stored: string | null | undefined): ApplicationExtras {
  const out: ApplicationExtras = { platform: "", country: "", referral: "", note: "" };
  const loose: string[] = [];
  let current: keyof ApplicationExtras | null = null;
  for (const line of (stored ?? "").split("\n")) {
    const hit = PREFIX.find(([, p]) => line.startsWith(p));
    if (hit) {
      current = hit[0];
      out[current] = line.slice(hit[1].length);
    } else if (current === "note") {
      out.note += `\n${line}`;
    } else if (line.trim()) {
      loose.push(line);
    }
  }
  if (loose.length) out.note = [loose.join("\n"), out.note].filter(Boolean).join("\n");
  return out;
}
