// Pure logic for Today's "Your first steps" checklist (RD-5). Kept free of
// React so the step signals, completion and first-run detection are unit-tested.
//
// The three steps the prior checklist tracked keep their exact signals:
//   build a wheel → wheelBuilt / not the starter wheel
//   add a fan      → fans > 0
//   share the link → spins > 0
// Two steps from the Command Center spec frame them: "Create your account"
// (always done — they're signed in) and "Fulfil your first win" (fulfilled > 0).
// C9: "Set your name and public link" — fans see "Creator" until the display
// name is set, and the bio link (/c/<handle>) needs the handle.

export interface FirstStepSignals {
  /** Display name AND public handle set (profileStepDone). Absent = done. */
  profileSet?: boolean;
  /** Server-derived (metrics.wheelBuilt) or the local "not the sample" check. */
  wheelSaved: boolean;
  fans: number;
  spins: number;
  fulfilled: number;
}

export interface FirstStep {
  key: "account" | "profile" | "wheel" | "fan" | "share" | "fulfil";
  title: string;
  body: string;
  done: boolean;
  /** CTA label + dashboard section. Absent for steps with nothing to do. */
  cta?: { label: string; go: string };
}

export function buildFirstSteps(s: FirstStepSignals): FirstStep[] {
  return [
    {
      key: "account",
      title: "Create your account",
      body: "You're in — welcome to FanFunnel.",
      done: true,
    },
    {
      key: "profile",
      title: "Set your name and public link",
      body: "Fans see your display name on every game. Your public link (/c/your-handle) is the one for your bio.",
      done: s.profileSet !== false,
      cta: { label: "Open settings", go: "settings" },
    },
    {
      key: "wheel",
      title: "Build your first game",
      body: "Set your prizes, odds and brand colour. We started you with a sample.",
      done: s.wheelSaved,
      cta: { label: "Open game editor", go: "editor" },
    },
    {
      key: "fan",
      title: "Mint your first fan link",
      body: "Record a fan (and the spins they paid for) to mint their personal link.",
      done: s.fans > 0,
      cta: { label: "Mint a link", go: "fans" },
    },
    {
      key: "share",
      title: "Share their spin link",
      body: "Copy the fan's personal /spin link and send it to them in a DM: it holds their own paid spins, so it is never for your bio. When they spin, you're live.",
      done: s.spins > 0,
      cta: { label: "Get the link", go: "fans" },
    },
    {
      key: "fulfil",
      title: "Fulfil your first win",
      body: "Deliver a prize and mark it done.",
      done: s.fulfilled > 0,
      cta: { label: "Open fulfilment", go: "prizes" },
    },
  ];
}

export const FIRST_STEPS_TOTAL = 6;

/** C9: the profile step's signal from GET /api/account (display name + handle). */
export function profileStepDone(account: { displayName?: string | null; publicSlug?: string | null } | null | undefined): boolean {
  if (!account) return false;
  const named = !!account.displayName?.trim();
  // An older response without the field: judge by the name alone.
  const linked = account.publicSlug === undefined || !!account.publicSlug?.trim();
  return named && linked;
}

export function firstStepsDone(s: FirstStepSignals): number {
  return buildFirstSteps(s).filter((x) => x.done).length;
}

/** Every step complete: the checklist self-hides and the dismissal is persisted once. */
export function firstStepsAllDone(s: FirstStepSignals): boolean {
  return buildFirstSteps(s).every((x) => x.done);
}

/** A brand-new account: nothing has happened yet, so Today shows its first-run
 *  framing (muted pulse chips, the checklist instead of an empty action feed). */
export function isFirstRun(s: { fans: number; spins: number }): boolean {
  return s.fans === 0 && s.spins === 0;
}
