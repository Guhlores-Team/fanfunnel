import assert from "node:assert/strict";
import { displayNameErrorMessage, displayNameInputError, displayNameRpcError, publicProfileErrorMessage, publicProfileRpcError } from "./profileErrors";
import { descriptionError, labelError, validateWheelDraft } from "./games/wheel/validate";
import { wheelSaveErrorMessage } from "@/components/dashboard/wheelSaveErrors";
import { RESERVED_NAME_MESSAGE } from "./reservedNames";
import type { WheelConfig } from "./games/wheel/types";

// TS-03/TS-04 wiring: the reserved-name and public-text rules reach every
// validator a creator's public text passes through, and every refusal code
// has creator-facing copy (raw codes never reach the UI). The routes
// themselves are exercised by e2e/trust-b7.mjs.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

// Display name (Settings, admin invite, sign-up).
check("a plain name passes", displayNameInputError("Jane Doe") === null);
check("the brand is reserved", displayNameInputError("FanFunnel Support") === "name_reserved");
check("a leet staff word is reserved", displayNameInputError("Supp0rt") === "name_reserved");
check("an admin may name a staff account", displayNameInputError("FanFunnel Support", { allowReserved: true }) === null);
check("a link in a name is refused", displayNameInputError("Jane t.me/jane") === "contains_link");
check("a phone number in a name is refused", displayNameInputError("Jane 555-123-4567") === "contains_phone");
check("an e-mail-shaped name keeps its own code", displayNameInputError("jane@example.com") === "name_looks_like_email");
check("an e-mail inside a name is refused", displayNameInputError("Jane (jane@example.com)") === "contains_email");
check("a slur in a name is refused", displayNameInputError("Jane the f@ggot") === "contains_slur");
check("length still wins first", displayNameInputError("x".repeat(81)) === "name_too_long");
check("name_reserved has copy", displayNameErrorMessage("name_reserved") === RESERVED_NAME_MESSAGE);
check("contains_link has copy", /links or web addresses/.test(displayNameErrorMessage("contains_link")));
check("unknown codes keep the generic line", displayNameErrorMessage("db_error") === "Couldn't save your name. Please try again.");

// The database's own refusals (0073) arrive as the same codes.
check("set_display_name 'reserved' → name_reserved", displayNameRpcError({ code: "22023", message: "display name is reserved" }) === "name_reserved");
check("set_display_name e-mail refusal unchanged", displayNameRpcError({ code: "22023", message: "display name must not contain the account e-mail" }) === "name_looks_like_email");
check("set_public_profile 'reserved' → slug_reserved", publicProfileRpcError({ code: "22023", message: "public slug is reserved" }) === "slug_reserved");
check("set_public_profile slug shape refusal unchanged", publicProfileRpcError({ code: "22023", message: "invalid public slug" }) === "invalid_slug");

// Public page (slug, tagline, note).
check("slug_reserved has copy", /reserved for FanFunnel/.test(publicProfileErrorMessage("slug_reserved")));
check("contains_phone has copy on the public page card", /phone numbers/.test(publicProfileErrorMessage("contains_phone")));
check("unknown public-page codes keep the generic line", publicProfileErrorMessage("db_error") === "Couldn't save your public page. Please try again.");

// Prize names and descriptions (editor inline + PUT /api/wheel).
check("a prize name with a link is refused inline", labelError("Pay at cash.app/xyz") === "Prize names can't include links or web addresses.");
check("a prize name with a handle is refused inline", labelError("DM @jane for it") === "Prize names can't include @handles or usernames for other apps.");
check("an ordinary prize name passes", labelError("Signed polaroid") === null);
check("an empty description passes", descriptionError("") === null && descriptionError(undefined) === null);
check("a long description is refused", typeof descriptionError("x".repeat(281)) === "string");
check("a description with a phone number is refused", descriptionError("Call 555 123 4567 to claim") === "Prize descriptions can't include phone numbers.");
const draft: WheelConfig = {
  prizes: [
    { id: "a", label: "Selfie", description: "see www.example.com", rarity: "common", weight: 10 },
    { id: "b", label: "Call", rarity: "rare", weight: 1 },
  ],
  brandColor: "#ec4899",
} as unknown as WheelConfig;
const errors = validateWheelDraft(draft);
check("validateWheelDraft reports the description problem on its prize", errors.prizes.a?.description === "Prize descriptions can't include links or web addresses.");
check("…as an issue keyed to the field", errors.issues.some((i) => i.key === "prize:a:description"));

// Save-route codes have toast copy.
check("contains_link save copy", wheelSaveErrorMessage("contains_link") === "Couldn't save: public text can't include links or web addresses. Fans see it, so keep contact details off it.");
check("contains_slur save copy", wheelSaveErrorMessage("contains_slur") === "Couldn't save: public text can't include that word.");
check("other codes unchanged", wheelSaveErrorMessage("bad_weight") === "Couldn't save: tickets must be whole numbers.");

console.log(`public text wiring: ${passed} checks passed`);
