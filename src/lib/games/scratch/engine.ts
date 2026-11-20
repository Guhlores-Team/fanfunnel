import { visibleIdentity as visible } from "../core/visibleIdentity";
import { shuffled } from "../core/random";

export interface ScratchSymbol { id: string; label: string; emoji: string | null }
export interface ScratchCell extends ScratchSymbol { kind: "prize" | "decoration" }
export interface ScratchPresentation { kind: "scratch"; cells: ScratchCell[] }

/** Public decorative identities, fixed by scratch-v1. They never imply a prize. */
export const SCRATCH_DECORATIONS = [
  ["circle", "Circle", "●"], ["square", "Square", "■"],
  ["triangle", "Triangle", "▲"], ["diamond", "Diamond", "◆"],
  ["star", "Star", "★"], ["flower", "Flower", "✿"],
  ["crescent", "Crescent", "☾"], ["sun", "Sun", "☀"],
  ["heart", "Heart", "♥"], ["cross", "Cross", "✚"],
  ["hexagon", "Hexagon", "⬡"], ["pentagon", "Pentagon", "⬟"],
  ["outline-triangle", "Outline triangle", "△"], ["outline-diamond", "Outline diamond", "◇"],
  ["ring", "Ring", "○"], ["clover", "Clover", "♣"],
  ["spade", "Spade", "♠"], ["lightning", "Lightning", "ϟ"],
  ["note", "Musical note", "♪"], ["infinity", "Infinity", "∞"],
] as const;

/** Three winning identities and six distinct nonwinning identities, never pairs. */
export function scratchFace(
  winner: ScratchSymbol,
  catalog: readonly ScratchSymbol[],
  rng: () => number,
): ScratchPresentation {
  const ids = new Set([winner.id]);
  const labels = new Set([visible(winner.label)]);
  const winningEmoji = winner.emoji && visible(winner.emoji) ? winner.emoji : null;
  const emoji = new Set([visible(winningEmoji ?? "◇")]);
  const decoys: ScratchCell[] = [];
  const accept = (cell: ScratchCell) => {
    if (decoys.length === 6 || ids.has(cell.id) || !cell.emoji || !visible(cell.emoji) || labels.has(visible(cell.label)) || emoji.has(visible(cell.emoji))) return;
    ids.add(cell.id);
    labels.add(visible(cell.label));
    if (cell.emoji) emoji.add(visible(cell.emoji));
    decoys.push(cell);
  };
  for (const p of [...catalog].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (p.id !== winner.id) accept({ kind: "prize", id: p.id, label: p.label, emoji: p.emoji });
  }
  for (const [id, label, symbol] of SCRATCH_DECORATIONS) {
    accept({ kind: "decoration", id: `scratch-v1:${id}`, label: `Decorative ${visible(label)}`, emoji: symbol });
  }
  if (decoys.length !== 6) throw new Error("Insufficient distinct scratch symbols");
  const winning: ScratchCell = { kind: "prize", id: winner.id, label: winner.label, emoji: winningEmoji };
  return { kind: "scratch", cells: shuffled([winning, winning, winning, ...shuffled(decoys, rng)], rng).map((cell) => ({ ...cell })) };
}
