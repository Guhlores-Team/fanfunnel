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
const g = globalThis as unknown as { __ffDemoPublicProfile?: DemoPublicProfile };

export function mockGetPublicProfileFields(): DemoPublicProfile {
  return { ...(g.__ffDemoPublicProfile ??= { ...DEFAULTS }) };
}

export function mockSetPublicProfileFields(patch: Partial<DemoPublicProfile>): void {
  const current = (g.__ffDemoPublicProfile ??= { ...DEFAULTS });
  for (const [key, value] of Object.entries(patch) as [keyof DemoPublicProfile, string | undefined][]) {
    if (value !== undefined) current[key] = value;
  }
}

/** Test hook. */
export function resetMockPublicProfile(): void {
  g.__ffDemoPublicProfile = { ...DEFAULTS };
}
