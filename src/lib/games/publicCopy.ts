// Fan-facing copy for the public surfaces (link-in-bio /c/<slug>, the share
// card and its OG image) that depends on which game a creator runs. A scratch
// or bingo creator must never be advertised as a "prize wheel".
import type { GameKind } from "@/lib/games/core/gameProof";

export interface PublicGameCopy {
  kind: GameKind;
  emoji: string;
  /** Appended to the creator's name in the page `<title>`. */
  titleSuffix: string;
  /** Shown when the creator has not written a tagline. */
  defaultTagline: string;
  /** Metadata description when the creator has not written a tagline. */
  metaDescription: string;
  cta: string;
  dmLine: (creator: string) => string;
  everyPlayWins: string;
  /** "Won on <creator>'s …" body line of the share card. */
  wonOn: (creator: string) => string;
  /** Share metadata description, e.g. "A Rare drop on X's wheel." */
  dropOn: (rarity: string, creator: string) => string;
  ogFooter: string;
  shareFooter: string;
}

/** "A Rare", "An Uncommon", "An Epic". */
const a = (word: string) => (/^[aeiou]/i.test(word) ? `An ${word}` : `A ${word}`);

const COPY: Record<GameKind, PublicGameCopy> = {
  wheel: {
    kind: "wheel",
    emoji: "🎡",
    titleSuffix: "Prize Wheel",
    defaultTagline: "Spin my wheel — every spin lands on a prize. 🎁",
    metaDescription: "Spin my wheel — every spin lands on a prize. 🎡",
    cta: "Get your spins →",
    dmLine: (c) => `DM ${c} to get your personal spin link.`,
    everyPlayWins: "Every spin lands on a prize · rare drops keep it exciting",
    wonOn: (c) => `Won on ${c}’s prize wheel — every spin lands on a prize.`,
    dropOn: (r, c) => `${a(r)} drop on ${c}'s wheel.`,
    ogFooter: "🎉 I just won this — every spin lands on a prize",
    shareFooter: "Powered by FanFunnel · every spin lands on a prize",
  },
  scratch: {
    kind: "scratch",
    emoji: "🎫",
    titleSuffix: "Scratch Tickets",
    defaultTagline: "Scratch my tickets — every ticket wins a prize. 🎁",
    metaDescription: "Scratch to win — every ticket wins a prize. 🎫",
    cta: "Get your tickets →",
    dmLine: (c) => `DM ${c} to get your personal ticket link.`,
    everyPlayWins: "Every ticket wins · rare drops keep it exciting",
    wonOn: (c) => `Won on ${c}’s scratch tickets — every ticket wins.`,
    dropOn: (r, c) => `${a(r)} drop on ${c}'s scratch tickets.`,
    ogFooter: "🎉 I just won this — every ticket wins",
    shareFooter: "Powered by FanFunnel · every ticket wins",
  },
  bingo: {
    kind: "bingo",
    emoji: "🔢",
    titleSuffix: "Bingo",
    defaultTagline: "Play my bingo — every play wins a prize, and every line wins another. 🎁",
    metaDescription: "Play bingo — every play wins a prize, and every line wins another. 🔢",
    cta: "Get your plays →",
    dmLine: (c) => `DM ${c} to get your personal bingo link.`,
    everyPlayWins: "Every play wins · every line wins another prize",
    wonOn: (c) => `Won on ${c}’s bingo card — every play wins.`,
    dropOn: (r, c) => `${a(r)} drop on ${c}'s bingo card.`,
    ogFooter: "🎉 I just won this — every play wins",
    shareFooter: "Powered by FanFunnel · every play wins",
  },
};

/** Normalizes any stored value; anything unknown reads as the wheel. */
export function publicGameKind(kind: unknown): GameKind {
  return kind === "scratch" || kind === "bingo" ? kind : "wheel";
}

export function publicGameCopy(kind: unknown): PublicGameCopy {
  return COPY[publicGameKind(kind)];
}
