import assert from "node:assert";
import { spinErrorInfo, ackErrorMessage } from "./spinErrors";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// Every code the spin route / data layer can return (SpinError in
// src/lib/data/index.ts plus the route's own bad_request). Each must map to its
// own fan-facing message, never the generic fallback.
const KNOWN = [
  "no_spins",
  "rate_limited",
  "blocked",
  "on_break",
  "needs_ack",
  "no_prizes",
  "not_found",
  "db_error",
  "bad_request",
] as const;

const generic = spinErrorInfo("something_unexpected").message;
const seen = new Set<string>();
for (const code of KNOWN) {
  const { message } = spinErrorInfo(code);
  check(`${code} has a message`, message.length > 0);
  check(`${code} does not fall through to the generic message`, message !== generic);
  check(`${code} message is distinct`, !seen.has(message));
  seen.add(message);
  // Fans must never see raw server codes or creator-facing jargon.
  check(`${code} does not leak the raw code`, !message.includes(code) && !message.includes("_"));
}

// needs_ack: the fan can continue by re-acknowledging, so the UI must re-show the gate.
check("needs_ack re-opens the age gate", spinErrorInfo("needs_ack").reopenAgeGate === true);
for (const code of KNOWN.filter((c) => c !== "needs_ack")) {
  check(`${code} does not re-open the age gate`, !spinErrorInfo(code).reopenAgeGate);
}

// on_break (RM-6): the page reloads its play state so SPIN shows the break.
check("on_break refreshes the play state", spinErrorInfo("on_break").refreshPlay === true);
check("on_break reassures that spins and prizes are safe", /spins and prizes are safe/.test(spinErrorInfo("on_break").message));
for (const code of KNOWN.filter((c) => c !== "on_break")) {
  check(`${code} does not refresh the play state`, !spinErrorInfo(code).refreshPlay);
}

check("no_prizes says the wheel is not ready", /isn.t ready yet/i.test(spinErrorInfo("no_prizes").message));

// Unknown / malformed input still yields the safe generic message.
for (const bad of [undefined, null, 42, {}, "", "totally_new_code"]) {
  check(`unknown input ${JSON.stringify(bad)} -> generic`, spinErrorInfo(bad).message === generic);
}

// Existing messages are preserved verbatim.
check("no_spins message unchanged", spinErrorInfo("no_spins").message === "You're out of spins! Tip your creator to get more. 💖");
check("rate_limited message unchanged", spinErrorInfo("rate_limited").message === "Whoa, slow down a sec — try again in a moment. 😅");
check("blocked message unchanged", spinErrorInfo("blocked").message === "This link isn't active. Reach out to your creator.");

// --- age-gate acknowledgement failures (POST /api/fans/ack) -------------------
const ackGeneric = ackErrorMessage(undefined);
check("ack generic is a retryable fan message", /try again/i.test(ackGeneric));
const ackSeen = new Set<string>();
for (const code of ["rate_limited", "not_found", "db_error", "bad_request"]) {
  const m = ackErrorMessage(code);
  check(`ack ${code} is specific`, m !== ackGeneric && !ackSeen.has(m));
  ackSeen.add(m);
  check(`ack ${code} does not leak the raw code`, !m.includes(code) && !m.includes("_"));
}
for (const bad of [null, 7, {}, "", "totally_new_code"]) {
  check(`ack unknown ${JSON.stringify(bad)} -> generic`, ackErrorMessage(bad) === ackGeneric);
}

console.log(`spinErrors.test: ${passed} checks passed`);
