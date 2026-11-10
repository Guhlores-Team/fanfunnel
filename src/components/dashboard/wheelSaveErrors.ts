import { MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { MIN_WHEEL_PRIZES, NO_WINNABLE_PRIZE, gameNoun } from "@/lib/games/wheel/validate";
import { publicTextErrorMessage } from "@/lib/publicText";

/**
 * Creator-facing copy for the `error` codes PUT /api/wheel returns. Pure, so
 * the wheel editor's save handler can show a readable toast for any code
 * (raw codes never reach the UI) and the mapping can be unit-tested.
 */
const MESSAGES: Record<string, string> = {
  too_few_prizes: `Couldn't save: a wheel needs at least ${MIN_WHEEL_PRIZES} prizes.`,
  prize_name_required: "Couldn't save: give every prize a name.",
  no_winnable_prize: `Couldn't save: ${NO_WINNABLE_PRIZE.charAt(0).toLowerCase()}${NO_WINNABLE_PRIZE.slice(1)}`,
  bad_color: "Couldn't save: a color or stock value is invalid.",
  brand_too_dark: "Couldn't save: that brand color is too dark to see on the fan page. Pick a lighter one.",
  bad_stock: "Couldn't save: a color or stock value is invalid.",
  bad_weight: "Couldn't save: tickets must be whole numbers.",
  too_many_prizes: `Couldn't save: a wheel can have at most ${MAX_WHEEL_PRIZES} prizes.`,
  stale_editor: "Couldn't save: this editor is out of date. Reload the page and try again.",
  not_found: "Couldn't save: this wheel no longer exists. Reload the page.",
  unauthorized: "Couldn't save. Are you signed in?",
  forbidden: "Couldn't save: this account can't change games right now.",
};

const GENERIC = "Couldn't save. Try again.";

/** `kind` (the game being saved) only changes the noun in too_few_prizes. */
export function wheelSaveErrorMessage(code: unknown, kind: unknown = "wheel"): string {
  if (code === "too_few_prizes") return `Couldn't save: a ${gameNoun(kind)} needs at least ${MIN_WHEEL_PRIZES} prizes.`;
  const publicText = publicTextErrorMessage(code);
  if (publicText) return `Couldn't save: ${publicText.charAt(0).toLowerCase()}${publicText.slice(1)}`;
  return typeof code === "string" && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : GENERIC;
}
