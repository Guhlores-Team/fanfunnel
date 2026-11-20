import type { CreatorDraftScope, CreatorDraftState } from "./CreatorDrafts";
import type { DeliveryNavigationState } from "./deliveryNavigation";

/** A local close only concerns its scope; page navigation concerns every draft. */
export const creatorScopeIncludes = (scope: CreatorDraftScope | undefined, value: string) => scope === undefined || (typeof scope === "string" ? scope === value : scope.includes(value));
export function creatorNavigationState(records: ReadonlyMap<string, CreatorDraftState>, delivery: DeliveryNavigationState, scope?: CreatorDraftScope) {
  const selected = [...records.values()].filter((record) => creatorScopeIncludes(scope, record.scope));
  return {
    dirty: (scope === undefined && delivery.dirty) || selected.some((record) => record.dirty),
    pending: (scope === undefined && delivery.pending) || selected.some((record) => record.pending),
    descriptions: [...new Set([...(scope === undefined && delivery.dirty ? ["prize delivery"] : []), ...selected.filter((record) => record.dirty).map((record) => record.description)])],
    pendingDescriptions: [...new Set([...(scope === undefined && delivery.pending ? ["prize delivery"] : []), ...selected.filter((record) => record.pending).map((record) => record.description)])],
  };
}
