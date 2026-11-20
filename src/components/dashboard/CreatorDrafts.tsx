"use client";

import { createContext, useContext, useEffect, useId, type ReactNode } from "react";

export interface CreatorDraftState { scope: string; description: string; dirty: boolean; pending: boolean }
export type CreatorDraftScope = string | readonly string[];
export interface CreatorLeaveOptions { scope?: CreatorDraftScope; consequence?: string }
interface CreatorDraftRegistry {
  register: (id: string, state: CreatorDraftState | null) => void;
  leave: (action: () => void, options?: CreatorLeaveOptions) => void;
}
const Registry = createContext<CreatorDraftRegistry | null>(null);
export function CreatorDraftProvider({ value, children }: { value: CreatorDraftRegistry; children: ReactNode }) {
  return <Registry.Provider value={value}>{children}</Registry.Provider>;
}
/** Registry contains only flags/descriptions, never form values or credentials. */
export function useCreatorDraft(scope: string, description: string, dirty: boolean, pending: boolean) {
  const registry = useContext(Registry);
  const id = useId();
  const register = registry?.register;
  useEffect(() => {
    register?.(id, { scope, description, dirty, pending });
    return () => register?.(id, null);
  }, [register, id, scope, description, dirty, pending]);
}
export function useCreatorLeave() {
  const registry = useContext(Registry);
  return registry?.leave ?? ((action: () => void) => action());
}
