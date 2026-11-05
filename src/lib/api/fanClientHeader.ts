/**
 * Header a fan page sends on its public polled reads (leaderboard, recent
 * wins) carrying its own link token. Client-safe (no server imports): the
 * widgets set it, `limitSharedRead` reads it. It only partitions the rate
 * limit; it is never read as a credential and never changes a response.
 */
export const FAN_CLIENT_HEADER = "x-fan-token";
