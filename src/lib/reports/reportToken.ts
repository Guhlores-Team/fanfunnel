import { createHash } from "node:crypto";

// Batch 6 N4: a fan report used to store the fan's full link token, a bearer
// credential, though Admin only ever shows a 4-character hint. A report now
// stores `t1:<last 4>:<sha256 of the token>`: enough to show the hint and to
// find (and erase) a fan's reports from their token, never enough to use it.
// Rows written before this change still hold the raw token; every reader
// below accepts both.

const STORED = /^t1:([A-Za-z0-9_-]{0,4}):([0-9a-f]{64})$/;

export function reportTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** What a report stores for the link it came from. */
export function storedReportToken(token: string): string {
  return `t1:${token.slice(-4)}:${reportTokenDigest(token)}`;
}

/** Every stored form a report from this token may have (new and legacy). */
export function reportTokenForms(token: string): string[] {
  return [storedReportToken(token), token];
}

/** Whether a stored report value came from this token. */
export function reportTokenMatches(stored: string | null | undefined, token: string): boolean {
  if (!stored) return false;
  const m = STORED.exec(stored);
  return m ? m[2] === reportTokenDigest(token) : stored === token;
}

/** The admin's hint for a stored value: "…abcd", or null. */
export function reportTokenHint(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const m = STORED.exec(stored);
  const tail = m ? m[1] : stored.slice(-4);
  return tail ? `…${tail}` : null;
}
