import type { Json } from "@/lib/data/db.types";
import { FAN_EXPORT_TOKEN_TAIL } from "./config";

/**
 * The shapes of the two "Download my data" files. Shared by the Supabase and
 * demo data layers so both produce the same file.
 *
 * Fan export: only this fan's own records with this one creator. Never another
 * fan's data, never the creator's private fields (prize costs, the creator's
 * notes and tags on the fan, internal due dates, campaign names) and never the
 * pre-committed seed of the fan's NEXT spin (only spent seeds, which /verify
 * already reveals).
 */
export const FAN_EXPORT_FORMAT = "fanfunnel.fan-data.v1";
export const CREATOR_EXPORT_FORMAT = "fanfunnel.creator-data.v1";

export interface FanDataExport {
  format: typeof FAN_EXPORT_FORMAT;
  exportedAt: string;
  about: string;
  creator: { displayName: string | null };
  profile: {
    displayName: string | null;
    handle: string | null;
    joinedAt: string | null;
    spinsRemaining: number;
    spinsGrantedTotal: number;
    lastSpinAt: string | null;
    referralCode: string | null;
    joinedThroughAReferral: boolean;
    friendsReferred: number;
  };
  consents: {
    ageAndTermsAcceptedAt: string | null;
    leaderboardOptIn: boolean;
  };
  links: {
    /** Last characters only, so this file can't be used to open every link. */
    linkEndsWith: string;
    isThisLink: boolean;
    wheel: string | null;
    createdAt: string | null;
    active: boolean;
    pausedByYouAt: string | null;
    spinsRemaining: number;
    spinsGrantedTotal: number;
    lastSpinAt: string | null;
  }[];
  topUps: { at: string; spins: number; bonusSpins: number }[];
  spins: {
    id: string;
    at: string;
    prize: string;
    rarity: string;
    wheel: string | null;
    shareId: string | null;
    fairness: {
      version: number | null;
      serverSeed: string | null;
      serverSeedHash: string | null;
      clientSeed: string | null;
      nonce: number | null;
      seedCommitment: string | null;
      poolHash: string | null;
      poolSnapshot: Json | null;
      trace: Json | null;
    };
  }[];
  prizes: { spinId: string | null; prize: string; status: string; wonAt: string; fulfilledAt: string | null }[];
  wishlist: { prize: string; rarity: string; addedAt: string }[];
  messagesYouSent: { at: string; body: string }[];
}

export interface CreatorDataExport {
  format: typeof CREATOR_EXPORT_FORMAT;
  exportedAt: string;
  about: string;
  /** Every section is a list of your own rows; fan link tokens are shortened. */
  account: Record<string, unknown>;
  sections: Record<string, Record<string, unknown>[]>;
  /** Sections that hit the row cap (the export is partial for those). */
  truncated: string[];
  /** Sections that couldn't be read this time (the file is missing them; try
   *  the download again). Empty when the export is complete. */
  failed: string[];
}

export const FAN_EXPORT_ABOUT =
  "Everything FanFunnel stores about you for this creator: your profile, links and balances, " +
  "every spin with its fairness proof, your prizes, wishlist, the messages you sent and your " +
  "consents. Link codes are shortened so this file can't open your links.";

export const CREATOR_EXPORT_ABOUT =
  "Everything your FanFunnel account owns: your account and settings, wheels and prizes, " +
  "campaigns and packs, fans (with your notes), spins, redemptions, top-ups, messages and more. " +
  "Fan link codes are shortened so this file can't open your fans' links. Keep it private: it " +
  "contains your fans' names and chats.";

/** "…a1b2" — the last few characters of a link token. */
export function maskToken(token: string | null | undefined): string {
  const t = token ?? "";
  return t.length <= FAN_EXPORT_TOKEN_TAIL ? "…" : "…" + t.slice(-FAN_EXPORT_TOKEN_TAIL);
}

/** The download file name for an export made at `at`. */
export function exportFileName(kind: "fan" | "creator", at: Date): string {
  return `fanfunnel-${kind === "fan" ? "my-data" : "account-data"}-${at.toISOString().slice(0, 10)}.json`;
}
