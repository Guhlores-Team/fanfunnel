// "Top up spins › Add spins to" in the fan drawer. Pure, so the choice the
// creator reads is unit-tested against the server's contract:
//
//  - POST /api/passes { fanId, wheelId } credits the fan's OLDEST active link
//    whose stored game (fan_passes.wheel_id) is `wheelId`, or mints a NEW link
//    stored on that game when the fan has none (_create_pass_grant_core, 0065).
//  - The stored game must be playable (archived/draft → no_wheel).
//  - A top-up with a campaign moves the credited link into that campaign.
//  - What a link PLAYS is the resolver's answer (link pin → campaign → live),
//    not its stored game.
//
// So each existing link is offered by what it plays, and a new link is only
// offered as "New link that plays X": the drawer pins it to X after the grant.
import { isPlayableGame } from "@/lib/games/liveGame";
import { spinsText } from "@/lib/format";
import { KIND_SHORT, kindOf, linkGame, pinUnavailableReason, type ChoiceCampaign, type ChoiceGame } from "./gameAssignment";

export interface TopUpPass {
  token: string;
  wheelId: string;
  campaignId?: string | null;
  pinnedWheelId?: string | null;
  campaignName: string | null;
  spinsRemaining: number;
  createdAt?: string;
}

export interface TopUpTarget {
  /** Option value: the link's token, or `new:<gameId>`. */
  key: string;
  /** Sent to POST /api/passes as `wheelId`. */
  wheelId: string;
  /** The existing link that receives the spins, or null for a new link. */
  token: string | null;
  /** A new link is set to play this game once it exists. */
  pinWheelId: string | null;
  label: string;
  /** What the credited link plays after this top-up. */
  plays: ChoiceGame | null;
  /** What it plays before the top-up (differs when the campaign moves it). */
  playsBefore: ChoiceGame | null;
  linkName: string;
  spinsRemaining: number;
}

export { spinsText };

/** Oldest first, the order the server picks a link in (created_at, then token). */
function byCreated(a: TopUpPass, b: TopUpPass): number {
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.token.localeCompare(b.token);
}

interface LinkParts { where: string; game: string | null; suffix: string }

function linkParts(passes: readonly TopUpPass[], campaigns: readonly ChoiceCampaign[], games: readonly ChoiceGame[], now: Date): Map<string, LinkParts> {
  const parts = new Map<string, LinkParts>();
  for (const pass of passes) {
    const where = pass.campaignName ? `Link in “${pass.campaignName}”` : "Link (no campaign)";
    parts.set(pass.token, { where, game: linkGame(pass, campaigns, games, now)?.game.title ?? null, suffix: "" });
  }
  const key = (p: LinkParts) => `${p.where}\u0000${p.game ?? ""}`;
  const counts = new Map<string, number>();
  for (const p of parts.values()) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const pass of [...passes].sort(byCreated)) {
    const p = parts.get(pass.token)!;
    if ((counts.get(key(p)) ?? 0) < 2) continue;
    const n = (seen.get(key(p)) ?? 0) + 1;
    seen.set(key(p), n);
    p.suffix = ` (${n})`;
  }
  return parts;
}

/**
 * A distinct name for every link: campaign (or "no campaign") plus the game it
 * plays, numbered oldest first only when two links would still read the same.
 */
export function linkNames(passes: readonly TopUpPass[], campaigns: readonly ChoiceCampaign[], games: readonly ChoiceGame[], now: Date): Map<string, string> {
  const out = new Map<string, string>();
  for (const [token, p] of linkParts(passes, campaigns, games, now)) out.set(token, `${p.where}${p.game ? ` · ${p.game}` : ""}${p.suffix}`);
  return out;
}

export function topUpTargets({ passes, campaigns, games, now, campaignId }: {
  passes: readonly TopUpPass[];
  campaigns: readonly ChoiceCampaign[];
  games: readonly ChoiceGame[];
  now: Date;
  /** The top-up's campaign ("" or undefined: the link keeps its own). */
  campaignId?: string | null;
}): { existing: TopUpTarget[]; fresh: TopUpTarget[] } {
  const parts = linkParts(passes, campaigns, games, now);
  const existing: TopUpTarget[] = [];
  const storedGames = new Set<string>();
  for (const pass of [...passes].sort(byCreated)) {
    // Only the oldest link per stored game can receive spins.
    if (storedGames.has(pass.wheelId)) continue;
    storedGames.add(pass.wheelId);
    const stored = games.find((game) => game.id === pass.wheelId);
    if (!stored || !isPlayableGame(stored)) continue;
    const playsBefore = linkGame(pass, campaigns, games, now)?.game ?? null;
    const plays = campaignId ? linkGame({ ...pass, campaignId }, campaigns, games, now)?.game ?? null : playsBefore;
    const p = parts.get(pass.token)!;
    const linkName = `${p.where}${p.suffix}`;
    existing.push({
      key: pass.token, wheelId: pass.wheelId, token: pass.token, pinWheelId: null,
      label: `${linkName}${plays ? ` · plays ${plays.title}` : " · no playable game"} (${spinsText(pass.spinsRemaining)})`,
      plays, playsBefore, linkName, spinsRemaining: pass.spinsRemaining,
    });
  }
  // A game the fan already has a stored link for always credits that link, so
  // a new link can only be offered for the other playable games.
  const fresh: TopUpTarget[] = games
    .filter((game) => !storedGames.has(game.id) && isPlayableGame(game) && pinUnavailableReason(game) === null)
    .map((game) => ({
      key: `new:${game.id}`, wheelId: game.id, token: null, pinWheelId: game.id,
      label: `New link that plays ${game.title} · ${KIND_SHORT[kindOf(game)]}`,
      plays: game, playsBefore: null, linkName: "a new link", spinsRemaining: 0,
    }));
  return { existing, fresh };
}

/** One plain sentence: where the spins land and what that link plays. */
export function topUpOutcome(target: TopUpTarget, campaignName: string | null, spins: number): string {
  if (!target.token) {
    return `Creates a new link for this fan with ${spinsText(spins)} that plays ${target.plays?.title ?? "that game"}. Send them the new link; their other links keep their own balances.`;
  }
  const after = `${target.linkName} gets ${spinsText(spins)} (${spinsText(target.spinsRemaining + spins)} after).`;
  if (!target.plays) return `${after} It has no playable game right now.`;
  const moved = campaignName && target.playsBefore && target.playsBefore.id !== target.plays.id
    ? ` Topping up in “${campaignName}” moves it into that campaign, so it will play ${target.plays.title} instead of ${target.playsBefore.title}.`
    : "";
  return `${after} It plays ${target.plays.title}.${moved}`;
}

/** What to do after a top-up whose receipt says "new link that plays `pin`". */
export type NewLinkPin =
  | { token: string }
  | { done: true }
  | { skip: "not_found" | "not_new" | "pinned_elsewhere" };

/**
 * The link a "New link that plays X" top-up must now set to play X. `credited`
 * is the token the grant reply returned; after "Check outcome" there is none
 * (the outcome carries no link), and the server's rule decides: the grant
 * credited the fan's OLDEST active link stored on X, minting it when there was
 * none, which is why X was offered as a new link. A link set to play another
 * game is never re-pointed, and one already set to X needs nothing.
 */
export function newLinkPin(passes: readonly TopUpPass[] | null | undefined, pin: string, credited?: string | null): NewLinkPin {
  const link = credited
    ? passes?.find((p) => p.token === credited)
    : [...(passes ?? [])].filter((p) => p.wheelId === pin).sort(byCreated)[0];
  // A token the list doesn't show yet is the link this grant just minted.
  if (!link) return credited ? { token: credited } : { skip: "not_found" };
  if (link.wheelId !== pin) return { skip: "not_new" };
  if (link.pinnedWheelId === pin) return { done: true };
  if (link.pinnedWheelId) return { skip: "pinned_elsewhere" };
  return { token: link.token };
}
