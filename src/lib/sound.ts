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

/**
 * Unlock + warm the AudioContext from inside a user gesture (e.g. the SPIN tap).
 * iOS Safari starts the context "suspended" and only resumes it during a real
 * gesture, so this MUST be called synchronously in the tap handler — otherwise
 * the later win fanfare (fired after the animation) is silent. Plays an
 * inaudible blip to fully wake the context on first use.
 */
export function unlockAudio() {
  const ac = audio();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume();
  // A near-silent tick warms the pipeline without being heard.
  try {
    blip(440, 0.01, "sine", 0.0001);
  } catch {
    /* ignore */
  }
}

/** Play several frequencies at once — a chord, for triumphant moments. */
function chord(freqs: number[], duration: number, type: OscillatorType, gain: number) {
  freqs.forEach((f) => blip(f, duration, type, gain));
}

/**
 * Win fanfare — richer for higher rarities. Common→rare get a quick ascending
 * arpeggio. Epic and legendary get a genuine jackpot moment: a faster run that
 * resolves into a sustained major chord, a low bass thump for impact, and a
 * high sparkle on top — legendary grander than epic.
 */
export function playWin(rarity: string) {
  if (rarity === "epic" || rarity === "legendary") {
    playBigWin(rarity === "legendary");
    return;
  }
  const scales: Record<string, number[]> = {
    common: [523, 659],
    uncommon: [523, 659, 784],
    rare: [523, 659, 784, 1047],
  };
  const notes = scales[rarity] ?? scales.common;
  notes.forEach((f, i) => {
    setTimeout(() => blip(f, 0.18, "triangle", 0.12), i * 90);
  });
}

/** The big-win jackpot fanfare for epic (and, grander, legendary) prizes. */
function playBigWin(legendary: boolean) {
  // Low bass thump for physical "impact".
  blip(legendary ? 110 : 147, 0.5, "sine", legendary ? 0.2 : 0.16);

  // Fast ascending run.
  const run = legendary
    ? [523, 659, 784, 1047, 1319, 1568]
    : [523, 659, 784, 1047, 1319];
  run.forEach((f, i) => setTimeout(() => blip(f, 0.16, "triangle", 0.13), i * 70));

  // Resolve into a sustained major chord once the run lands.
  const runEnd = run.length * 70;
  const finalChord = legendary ? [1047, 1319, 1568, 2093] : [784, 1047, 1319];
  setTimeout(() => chord(finalChord, legendary ? 0.8 : 0.55, "triangle", 0.12), runEnd);

  // High sparkle shimmer on top of the chord.
  const sparkle = legendary ? [2637, 3136, 3520] : [2093, 2637];
  sparkle.forEach((f, i) =>
    setTimeout(() => blip(f, 0.25, "sine", 0.07), runEnd + 60 + i * 80)
  );
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
