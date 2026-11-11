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

export interface ExportStatus {
  /** Complete means no requested section failed or hit a row cap. Reads occur
   *  while the file is prepared; concurrent changes may require another export. */
  complete: boolean;
  failed: string[];
  truncated: string[];
  /** Deliberate privacy/credential exclusions, not missing query results. */
  excluded: string[];
}

export interface FanDataExport extends ExportStatus {
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
    /** TS-13: whether the creator has blocked you. */
    blocked: boolean;
  };
  consents: {
    ageAndTermsAcceptedAt: string | null;
    termsVersion: string | null;
    leaderboardOptIn: boolean;
    /** TS-17: when you muted this creator's messages (null = not muted). */
    chatMutedAt: string | null;
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
  /** TS-13: amountCents is the amount the creator noted against the top-up (0 when none). */
  topUps: { at: string; spins: number; bonusSpins: number; amountCents: number }[];
  spins: {
    gameKind?: string;
    kind?: "play" | "bonus";
    parentSpinId?: string | null;
    bingoLine?: number | null;
    presentation?: Json | null;
    id: string;
    at: string;
    prize: string;
    rarity: string;
    wheel: string | null;
    shareId: string | null;
    /** WF-01: the claim code for this win (null when no code key is configured). */
    claimCode?: string | null;
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
  /** T9: each won prize's redemption status, plus the same words the fan page shows. */
  prizes: { spinId: string | null; prize: string; status: string; delivery: string | null; wonAt: string; fulfilledAt: string | null }[];
  /** Delivery metadata only; downloaded files never contain redeemable values. */
  instantReceipts: { spinId: string; kind: string; views: number; lastViewedAt: string | null; createdAt: string; erasedAt: string | null }[];
  bingoCards: {id:string;wheelId:string;cells:Json;markedMask:number;awardedLinesMask:number;version:number;status:string;createdAt:string|null;completedAt:string|null}[];
  bingoLineAwards: {cardId:string;line:number;primarySpinId:string;bonusSpinId:string;at:string|null}[];
  focusPacks: { kind: string; prize: string; multiplier: number; totalSpins: number; spinsLeft: number; chaseCounter: number; status: string; at: string | null; endedAt: string | null }[];
  spinAttempts: { status: string; error: string | null; at: string | null; finishedAt: string | null }[];
  wishlist: { prize: string; rarity: string; addedAt: string }[];
  messagesYouSent: { at: string; body: string }[];
  /** T9: messages the creator (or their team) sent you, and when you read them. */
  messagesYouReceived: { at: string; body: string; readAt: string | null }[];
  play: { breakUntil: string | null; reminderDaily: number | null; reminderUpdatedAt: string | null };
  checkIns: { day: string; recordedAt: string | null }[];
  outreach: { at: string; contactedAt: string | null }[];
  reportsYouSent: { at: string; reason: string; detail: string | null }[];
}

export interface CreatorDataExport extends ExportStatus {
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

export const FAN_EXPORT_EXCLUDED = [
  "Creator-private notes, tags, prize costs, due dates, queue snoozes and templates",
  "Records of unrelated people, full personal-link tokens and future spin seeds",
  "Device credentials, webhook destinations and reward values, hints, fingerprints and encryption material",
];
export const CREATOR_EXPORT_EXCLUDED = [
  "Full personal-link tokens and future spin seeds",
  "Request hashes, private retry contexts and encrypted attempt receipts",
  "Push endpoints and device keys, webhook destinations and other credentials",
  "Reward values, hints, fingerprints and encryption material; fan-private daily reminder values",
];
export const FAN_EXPORT_ABOUT =
  "Your records with this creator: profile, links and balances, spent-spin fairness proofs, " +
  "prizes and their delivery status, instant delivery and view metadata, personal bingo cards and line awards, wishlist, messages you sent and received, consents, play settings, check-ins, outreach history " +
  "and reports you submitted. Read complete, failed and truncated before relying on this file. " +
  "Listed exclusions protect private fields and credentials. Records are read while the file is prepared.";
export const CREATOR_EXPORT_ABOUT =
  "Your account, business records, play and outreach metadata, devices and agency records, read " +
  "through your own account permissions. Read complete, failed and truncated before relying on " +
  "this file; listed exclusions protect credentials and fan-private values. Records are read " +
  "while the file is prepared. Keep it private: it contains your fans' names and chats.";

/** "…a1b2" — the last few characters of a link token. */
export function maskToken(token: string | null | undefined): string {
  const t = token ?? "";
  return t.length <= FAN_EXPORT_TOKEN_TAIL ? "…" : "…" + t.slice(-FAN_EXPORT_TOKEN_TAIL);
}

/** The download file name for an export made at `at`. */
export function exportFileName(kind: "fan" | "creator", at: Date): string {
  return `fanfunnel-${kind === "fan" ? "my-data" : "account-data"}-${at.toISOString().slice(0, 10)}.json`;
}
