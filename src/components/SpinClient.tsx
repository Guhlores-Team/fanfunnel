"use client";

import type { ReactNode } from "react";
import type { FanPassView } from "@/lib/data/types";
import FanGameController from "./fan/FanGameController";

/** Every game shares token-bound play/recovery, safety and reward handling. */
export default function SpinClient({ pass, gallery = null }: { pass: FanPassView; gallery?: ReactNode }) {
  return <FanGameController key={pass.token} pass={pass} gallery={gallery} />;
}
