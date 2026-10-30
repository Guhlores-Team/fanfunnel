export interface DeliveryNavigationState {
  dirty: boolean;
  pending: boolean;
}

/** Wheel drafts persist across sections; secret delivery drafts do not. */
export function deliveryLeaveDecision(
  delivery: DeliveryNavigationState,
  wheelDirty: boolean,
  intent: "section" | "signout",
): "leave" | "confirm" | "wait" {
  if (delivery.pending) return "wait";
  if (delivery.dirty || (intent === "signout" && wheelDirty)) return "confirm";
  return "leave";
}
