import assert from "node:assert";
import { grantAmountCents, grantImpact, parseSpins } from "./grantImpact";

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

console.log(`grantImpact: ${passed} checks passed`);
