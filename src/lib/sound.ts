// Tiny Web Audio helper — no assets, no dependencies. Generates the wheel's
// tick and win sounds procedurally so there are no audio files to ship and
// nothing to load. Lazily creates the AudioContext on first use (after a user
// gesture) to satisfy browser autoplay policies.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function blip(freq: number, duration: number, type: OscillatorType, gain: number) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);
  osc.connect(g).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + duration + 0.02);
}

/** The "peg" click as a slice passes the pointer. */
export function playTick() {
  blip(900, 0.04, "square", 0.06);
}

/** Win fanfare — richer for higher rarities. */
export function playWin(rarity: string) {
  const scales: Record<string, number[]> = {
    common: [523, 659],
    uncommon: [523, 659, 784],
    rare: [523, 659, 784, 1047],
    epic: [523, 659, 784, 1047, 1319],
    legendary: [523, 659, 784, 1047, 1319, 1568],
  };
  const notes = scales[rarity] ?? scales.common;
  notes.forEach((f, i) => {
    setTimeout(() => blip(f, 0.18, "triangle", 0.12), i * 90);
  });
}

/** A short two-note "ping" for a new inbound message (creator inbox). */
export function playPing() {
  blip(880, 0.12, "sine", 0.1);
  setTimeout(() => blip(1175, 0.16, "sine", 0.1), 110);
}

/** Mobile haptic tap (no-op where unsupported). */
export function haptic(pattern: number | number[] = 12) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}
