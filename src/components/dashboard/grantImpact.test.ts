import assert from "node:assert";
import {
  grantAmountCents,
  grantImpact,
  grantPriceError,
  grantSaveAmount,
  parseSpins,
  perSpinText,
  revenueChangeText,
} from "./grantImpact";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- parseSpins ------------------------------------------------------------
{
  check("parseSpins whole number", parseSpins("4") === 4);
  check("parseSpins floors decimals", parseSpins("4.9") === 4);
  check("parseSpins clamps negatives to 0", parseSpins("-3") === 0);
  check("parseSpins empty is 0", parseSpins("") === 0);
  check("parseSpins junk is 0", parseSpins("abc") === 0);
}

// --- grantAmountCents ------------------------------------------------------
{
  check("$5/spin x 4 = 2000c", grantAmountCents("5", 4) === 2000);
  check("$0.33/spin x 3 rounds to 99c", grantAmountCents("0.33", 3) === 99);
  check("no price = 0c", grantAmountCents("", 4) === 0);
}

// --- grantImpact: the brief's example (used 3 of 5, set to 4) --------------
{
  const i = grantImpact({ grantSpins: 5, spinsInput: "4", fanSpinsRemaining: 2 });
  check("used = 3", i.used === 3);
  check("delta = -1", i.delta === -1);
  check("leaves 1", i.remainingAfter === 1);
  check("allowed", i.allowed);
  check(
    "message reads plainly",
    i.message === "This fan has used 3 of these 5 spins. Setting it to 4 takes back 1 spin and leaves 1 spin."
  );
}

// --- grantImpact: cut to exactly the used count is allowed (leaves 0) ------
{
  const i = grantImpact({ grantSpins: 5, spinsInput: "3", fanSpinsRemaining: 2 });
  check("cut to used count allowed", i.allowed && i.remainingAfter === 0);
  check("singular/plural: 0 spins", /leaves 0 spins\.$/.test(i.message));
}

// --- grantImpact: cut below spins already used is refused (COR-2 rule) -----
{
  const i = grantImpact({ grantSpins: 5, spinsInput: "2", fanSpinsRemaining: 2 });
  check("below used is refused", !i.allowed);
  check("refused balance would go negative", i.remainingAfter === -1);
  check("refusal names the floor", /isn't allowed: it can't go below the 3 spins already used\.$/.test(i.message));

  const zero = grantImpact({ grantSpins: 5, spinsInput: "0", fanSpinsRemaining: 0 });
  check("fully spent grant can't be zeroed", !zero.allowed && zero.used === 5);
}

// --- grantImpact: nothing used yet ----------------------------------------
{
  const i = grantImpact({ grantSpins: 5, spinsInput: "0", fanSpinsRemaining: 5 });
  check("unused grant can go to 0", i.allowed && i.used === 0 && i.remainingAfter === 0);
  check("lead states the balance when nothing used", i.message.startsWith("This fan has 5 spins left."));
}

// --- grantImpact: other grants cover the balance ---------------------------
{
  // Fan has 12 left across grants; this 5-spin grant can be cut freely.
  const i = grantImpact({ grantSpins: 5, spinsInput: "1", fanSpinsRemaining: 12 });
  check("balance above the grant: used 0", i.used === 0);
  check("cut leaves 8", i.allowed && i.remainingAfter === 8);
}

// --- grantImpact: increase and no change ----------------------------------
{
  const up = grantImpact({ grantSpins: 5, spinsInput: "7", fanSpinsRemaining: 2 });
  check("increase allowed", up.allowed && up.delta === 2 && up.remainingAfter === 4);
  check("increase wording", /Setting it to 7 adds 2 spins and leaves 4 spins\.$/.test(up.message));

  const same = grantImpact({ grantSpins: 5, spinsInput: "5", fanSpinsRemaining: 1 });
  check("no change allowed", same.allowed && same.delta === 0);
  check("no change wording + singular", /Spins unchanged, so they keep 1 spin\.$/.test(same.message));
}

// --- grantImpact: input parsed exactly like the save -----------------------
{
  const i = grantImpact({ grantSpins: 5, spinsInput: "3.7", fanSpinsRemaining: 2 });
  check("decimal input floors like save()", i.newSpins === 3 && i.allowed);
  const neg = grantImpact({ grantSpins: 5, spinsInput: "", fanSpinsRemaining: 5 });
  check("empty input is 0 like save()", neg.newSpins === 0);
}

// --- grantImpact: a negative stored balance never loosens the rule ---------
{
  const i = grantImpact({ grantSpins: 5, spinsInput: "4", fanSpinsRemaining: -2 });
  check("negative balance treated as 0", !i.allowed && i.used === 5);
}

// --- grantSaveAmount: recorded revenue never drifts on an untouched price ---
{
  // $10.00 over 3 spins: the $/spin field shows "3.33" (3.33 x 3 = $9.99).
  const g = { spins: 3, amountCents: 1000 };
  const shown = perSpinText(g.spins, g.amountCents);
  check("$/spin field shows the rounded price", shown === "3.33");

  // Only the campaign changes: spins and price untouched.
  const campaignOnly = grantSaveAmount({ grant: g, spinsInput: "3", perSpinInput: shown });
  check("campaign-only edit keeps 1000c (not 999c)", campaignOnly === 1000);

  // Field retyped to the same text still counts as untouched.
  check("same text retyped keeps 1000c", grantSaveAmount({ grant: g, spinsInput: "3.0", perSpinInput: "3.33" }) === 1000);

  // Spin count changes, price untouched: the field is "$ / spin", so the total
  // scales at the grant's exact original rate (1000/3 per spin), not at 3.33.
  check("3 -> 6 spins at the exact rate = 2000c", grantSaveAmount({ grant: g, spinsInput: "6", perSpinInput: shown }) === 2000);
  check("3 -> 4 spins at the exact rate = 1333c", grantSaveAmount({ grant: g, spinsInput: "4", perSpinInput: shown }) === 1333);
  check("3 -> 0 spins = 0c", grantSaveAmount({ grant: g, spinsInput: "0", perSpinInput: shown }) === 0);
}

// --- grantSaveAmount: a real price edit uses the typed price ----------------
{
  const g = { spins: 3, amountCents: 1000 };
  check("price edit $4 x 3 = 1200c", grantSaveAmount({ grant: g, spinsInput: "3", perSpinInput: "4" }) === 1200);
  check("price + spins edit $2.50 x 4 = 1000c", grantSaveAmount({ grant: g, spinsInput: "4", perSpinInput: "2.50" }) === 1000);
  check("price cleared = free grant (0c)", grantSaveAmount({ grant: g, spinsInput: "3", perSpinInput: "" }) === 0);
  check("price typed as the shown value (3.330) is untouched", grantSaveAmount({ grant: g, spinsInput: "3", perSpinInput: "3.330" }) === 1000);
}

// --- grantSaveAmount: grants with no derivable rate ---------------------------
{
  // Amount recorded on a 0-spin grant: the field starts empty; leave the amount.
  const zeroSpin = { spins: 0, amountCents: 500 };
  check("0-spin grant field starts empty", perSpinText(0, 500) === "");
  check("0-spin grant, untouched, keeps 500c", grantSaveAmount({ grant: zeroSpin, spinsInput: "0", perSpinInput: "" }) === 500);
  check("0-spin grant gaining spins keeps 500c (no rate to scale)", grantSaveAmount({ grant: zeroSpin, spinsInput: "2", perSpinInput: "" }) === 500);

  // Free grant stays free when spins change.
  const free = { spins: 5, amountCents: 0 };
  check("free grant field starts empty", perSpinText(5, 0) === "");
  check("free grant stays 0c", grantSaveAmount({ grant: free, spinsInput: "8", perSpinInput: "" }) === 0);
  check("free grant priced at $1 x 8 = 800c", grantSaveAmount({ grant: free, spinsInput: "8", perSpinInput: "1" }) === 800);

  // A sub-cent rate shows as "0.00" but must not wipe the amount when untouched.
  const tiny = { spins: 3, amountCents: 1 };
  check("tiny rate shows 0.00", perSpinText(3, 1) === "0.00");
  check("tiny rate untouched keeps 1c", grantSaveAmount({ grant: tiny, spinsInput: "3", perSpinInput: "0.00" }) === 1);
}

// --- revenueChangeText: the preview line only shows for a real change -------
{
  const g = { spins: 3, amountCents: 1000 };
  const line = (spinsInput: string, perSpinInput: string) =>
    revenueChangeText(g.amountCents, grantSaveAmount({ grant: g, spinsInput, perSpinInput }));
  check("no revenue line for a campaign-only edit", line("3", "3.33") === null);
  check("revenue line for a price edit", line("3", "4") === "Recorded revenue goes from $10.00 to $12.00.");
  check("revenue line when spins scale the total", line("6", "3.33") === "Recorded revenue goes from $10.00 to $20.00.");
  check("no revenue line when a price edit lands on the same total", line("4", "2.50") === null);
}

// --- grantPriceError: the $/spin field rejects what the server would 400 ---
{
  const g = { spins: 3, amountCents: 1000 };
  const err = (spinsInput: string, perSpinInput: string) => grantPriceError({ grant: g, spinsInput, perSpinInput });
  check("untouched price is valid", err("3", "3.33") === null);
  check("real price edit is valid", err("3", "4") === null);
  check("empty price (free) is valid", err("3", "") === null);
  check("zero price is valid", err("3", "0") === null);
  check("negative price is invalid", err("3", "-5") === "Price can't be negative.");
  check("non-finite price is invalid", err("3", "1e400") === "Enter a valid price.");
  check("junk price is invalid", err("3", "abc") === "Enter a valid price.");
  check("$1,000,000 total exactly is valid", err("4", "250000") === null);
  check("total over $1,000,000 is invalid", err("4", "250000.01") === "That's over the $1,000,000 limit for one grant.");
  // Price untouched but the spin count scales the total over the max.
  const big = { spins: 1, amountCents: 50_000_000 };
  check(
    "scaled total over the max is invalid",
    grantPriceError({ grant: big, spinsInput: "3", perSpinInput: perSpinText(1, 50_000_000) }) ===
      "That's over the $1,000,000 limit for one grant."
  );
}

console.log(`grantImpact: ${passed} checks passed`);
