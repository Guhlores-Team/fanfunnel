"use client";

import { createContext, useContext } from "react";

/** WG-18: the short commit this build came from, derived on the server and
 *  handed to Admin › System health. Undefined outside the admin's dashboard. */
export const BuildCommitContext = createContext<string | undefined>(undefined);

export function useBuildCommit(): string | undefined {
  return useContext(BuildCommitContext);
}
