// A19: pure helpers for the seat workspace (unit-tested without a browser).

export interface SeatCreatorView {
  creatorId: string;
  displayName: string;
  canChat: boolean;
  canFulfil: boolean;
}
export type SeatTab = "inbox" | "prizes";

/** The jobs a seat has for one creator, in display order. */
export function seatTabs(seat: Pick<SeatCreatorView, "canChat" | "canFulfil">): SeatTab[] {
  return [...(seat.canChat ? (["inbox"] as const) : []), ...(seat.canFulfil ? (["prizes"] as const) : [])];
}

/** `path` with the acting creator added as a query parameter. */
export function seatPath(path: string, creatorId: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}creatorId=${encodeURIComponent(creatorId)}`;
}
