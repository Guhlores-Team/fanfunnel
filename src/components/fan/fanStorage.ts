/**
 * Browser storage keyed on a fan link. The raw token is a bearer credential,
 * so it never becomes a storage key: every key is `<prefix>:<sha256(token)>`
 * (the spin-intent store uses the same shape). "Delete my data" clears them.
 */
export const FAN_STORAGE_PREFIXES = {
  chatOpen: "ff-chat-open-v1",
  chatSeen: "ff-chat-seen-v1",
  spinIntent: "ff-spin-intent-v1",
} as const;

export async function fanStorageKey(prefix: string, token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `${prefix}:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Remove everything this browser kept for one link (hashed keys and the pre-0068 raw ones). */
export async function clearFanStorage(token: string): Promise<void> {
  const keys = [
    ...(await Promise.all(Object.values(FAN_STORAGE_PREFIXES).map((prefix) => fanStorageKey(prefix, token)))),
    `ff_chat_open_${token}`,
    `ff_chat_seen_${token}`,
  ];
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
}
