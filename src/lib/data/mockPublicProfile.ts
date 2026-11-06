// A36: the demo creator's link-in-bio fields, so a demo save is really kept
// (it used to answer ok and keep nothing). Pinned to globalThis like the main
// mock store so the settings route, /c/<slug> and the fan page share it.
export interface DemoPublicProfile {
  slug: string;
  tipUrl: string;
  tagline: string;
  note: string;
  avatarUrl: string;
}

const DEFAULTS: DemoPublicProfile = { slug: "demo-creator", tipUrl: "", tagline: "", note: "", avatarUrl: "" };
/** The fan-page note the demo shows until the demo creator saves their own. */
const SAMPLE_NOTE = "Hey you 😘 spin away — every spin wins!";
type Stored = DemoPublicProfile & { noteSaved: boolean };
const g = globalThis as unknown as { __ffDemoPublicProfile?: Stored };
const stored = (): Stored => (g.__ffDemoPublicProfile ??= { ...DEFAULTS, noteSaved: false });

export function mockGetPublicProfileFields(): DemoPublicProfile {
  const { slug, tipUrl, tagline, note, avatarUrl } = stored();
  return { slug, tipUrl, tagline, note, avatarUrl };
}

export function mockSetPublicProfileFields(patch: Partial<DemoPublicProfile>): void {
  const current = stored();
  for (const [key, value] of Object.entries(patch) as [keyof DemoPublicProfile, string | undefined][]) {
    if (value !== undefined) current[key] = value;
  }
  if (patch.note !== undefined) current.noteSaved = true;
}

/**
 * The note on the demo fan page: the sample until the creator saves one, then
 * exactly what they saved, so clearing it shows no note (as on a real account).
 */
export function mockCreatorNote(): string | null {
  const { note, noteSaved } = stored();
  if (!noteSaved) return SAMPLE_NOTE;
  return note.trim() ? note : null;
}

/** Test hook. */
export function resetMockPublicProfile(): void {
  g.__ffDemoPublicProfile = { ...DEFAULTS, noteSaved: false };
}
