import { formatLegalDate } from "@/lib/legal";

/**
 * T5: what a fan sees about a won prize's delivery, from the existing
 * redemptions row (status + fulfilled_at). There is no cancel timestamp, so a
 * cancelled or waiting win carries no time of its own; callers show the win's
 * date for those.
 */
export type WinDeliveryStatus = "waiting" | "in_progress" | "delivered" | "cancelled";

export interface WinDelivery {
  status: WinDeliveryStatus;
  /** When it was delivered (fulfilled_at); null for the other states. */
  at: string | null;
}

/** Map a redemptions row to the fan's view, or undefined for an unknown status. */
export function toWinDelivery(status: unknown, fulfilledAt: unknown): WinDelivery | undefined {
  const at = typeof fulfilledAt === "string" && fulfilledAt ? fulfilledAt : null;
  switch (status) {
    case "pending":
      return { status: "waiting", at: null };
    case "in_progress":
      return { status: "in_progress", at: null };
    case "fulfilled":
      return { status: "delivered", at };
    case "cancelled":
      return { status: "cancelled", at: null };
    default:
      return undefined;
  }
}

/** One-to-one embeds come back as an object, an array or null; take the first row. */
export function firstEmbedded<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** A stable calendar date in UTC ("November 9, 2026"), the same on server and client. */
export function winDate(iso: string): string {
  const day = typeof iso === "string" ? iso.slice(0, 10) : "";
  try {
    return formatLegalDate(day);
  } catch {
    return "";
  }
}

/** Fan-facing words for a delivery state. */
export function deliveryLabel(delivery: WinDelivery): string {
  switch (delivery.status) {
    case "waiting":
      return "Waiting for the creator";
    case "in_progress":
      return "In progress";
    case "delivered": {
      const when = delivery.at ? winDate(delivery.at) : "";
      return when ? `Delivered ${when}` : "Delivered";
    }
    case "cancelled":
      return "Cancelled by the creator";
  }
}
