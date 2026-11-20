// Pure: the Games switcher's one-line schedule/status hint, unit-tested.

/**
 * A compact human hint describing a game's schedule window. `liveElsewhere`
 * is the title of the game fans get instead of this one right now (null when
 * this one is live): the active game a schedule is overriding says so rather
 * than reading "Always on" (QA b5 m11).
 */
export function scheduleHint(
  activeFrom: string | null,
  activeUntil: string | null,
  isActive: boolean,
  liveElsewhere: string | null = null,
): string {
  if (!activeFrom && !activeUntil) {
    if (!isActive) return "Not active";
    return liveElsewhere ? `Active, paused while ${liveElsewhere} is scheduled` : "Active, no schedule";
  }
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  if (activeFrom && activeUntil) return `${fmt(activeFrom)} → ${fmt(activeUntil)}`;
  if (activeFrom) return `From ${fmt(activeFrom)}`;
  return `Until ${fmt(activeUntil as string)}`;
}
