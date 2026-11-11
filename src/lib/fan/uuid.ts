/**
 * RF-04: a v4 UUID for browsers without `crypto.randomUUID` (iOS Safari before
 * 15.4, older Chrome / Samsung Internet and some webviews). The spin ledger
 * keys every attempt on this id, so the page must be able to mint one wherever
 * it can load at all; `getRandomValues` has shipped everywhere since 2013.
 */
export function randomUuid(cryptoLike: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string } = crypto): string {
  if (typeof cryptoLike.randomUUID === "function") return cryptoLike.randomUUID();
  const bytes = cryptoLike.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `Object.hasOwn` is Safari 15.4+; the fan page must answer on iOS 15.0. */
export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** `Array.prototype.at` is Safari 15.4+. */
export function lastOf<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[items.length - 1];
}
