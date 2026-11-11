import "server-only";
import { createHash, createHmac } from "node:crypto";
import { clientIp } from "@/lib/api/clientIp";
import { claimCodeKey } from "@/lib/rewards/crypto";

// TS-05 (0073): who answered the age/terms gate, kept as evidence for a
// dispute without keeping the address or the browser string themselves.
// record_fan_ack stores two 64-hex digests in fan_consent_evidence, a table
// no creator or seat can read (admins with MFA only).
//
// The digests are keyed (HMAC) with a key derived from the reward fingerprint
// key when one is configured, so the small IPv4 space cannot be walked back
// from a leaked table; without a key (demo, a bare preview) they fall back to
// a domain-separated SHA-256, which still never stores the raw value.

const DOMAIN = "fanfunnel-consent-evidence-v1";
const UA_MAX = 512;

export interface ConsentEvidence { ipHash: string | null; uaHash: string | null }

function digest(kind: "ip" | "ua", value: string): string {
  const key = claimCodeKey();
  const material = `${DOMAIN}:${kind}:${value}`;
  return key
    ? createHmac("sha256", createHmac("sha256", key).update(DOMAIN).digest()).update(material).digest("hex")
    : createHash("sha256").update(material).digest("hex");
}

/** Pure: the two digests for an address and a user-agent string (null when unknown). */
export function consentEvidenceFor(ip: string | null | undefined, userAgent: string | null | undefined): ConsentEvidence {
  const address = ip && ip !== "local" ? ip.trim() : "";
  const agent = (userAgent ?? "").trim().slice(0, UA_MAX);
  return { ipHash: address ? digest("ip", address) : null, uaHash: agent ? digest("ua", agent) : null };
}

/** The evidence for the request that answered the gate. */
export function consentEvidence(req: Request): ConsentEvidence {
  return consentEvidenceFor(clientIp(req), req.headers.get("user-agent"));
}
