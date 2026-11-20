import { sha256Hex } from "../wheel/fairness";
import { MAX_WHEEL_PRIZES } from "./types";

/**
 * Conservative bound for scratch-v1/bingo-v1 at the50-prize cap:
 * primary <=50 draws (49 failed candidates + final), card shuffle <=49,
 * bonus failures <=50 across all lines (global forward exclusions), and
 * <=4 successful line picks. Selected bonuses use zero draws; scratch uses13.
 * Thus153 exceeds either path, even before sharing primary/bonus exclusions.
 */
export const MAX_GAME_RANDOM_DRAWS = MAX_WHEEL_PRIZES + (MAX_WHEEL_PRIZES - 1) + MAX_WHEEL_PRIZES + 4;

/**
 * New game rules use the exact v3 SHA prefix/float decoding. First64 floats
 * equal makeFairRngV3; later floats continue SHA blocks instead of its legacy
 * 32-bit fallback. One returned stream feeds primary, retries and presentation.
 * Exhaustion throws BEFORE the economic commit; never reseed or fall back.
 */
export async function makeGameRngV3(serverSeed: string, clientSeed: string, nonce: number, poolHash: string): Promise<() => number> {
  if (!Number.isSafeInteger(nonce) || nonce < 0 || !/^[a-f0-9]{64}$/.test(poolHash)) throw new Error("Invalid game RNG commitment");
  const prefix = `${serverSeed}:${clientSeed}:${nonce}:${poolHash}`;
  const blocks = await Promise.all(Array.from({ length: Math.ceil(MAX_GAME_RANDOM_DRAWS / 8) }, (_, index) => sha256Hex(`${prefix}:${index}`)));
  const floats = blocks.flatMap((block) => Array.from({ length: 8 }, (_, index) => parseInt(block.slice(index * 8, index * 8 + 8), 16) / 4294967296));
  let cursor = 0;
  return () => {
    if (cursor >= MAX_GAME_RANDOM_DRAWS) throw new Error("Game random draw bound exceeded");
    return floats[cursor++];
  };
}
