import assert from "node:assert/strict";
import { csvRecords, parseDollars, parseFanCsv, parseSpins, MAX_IMPORT_ROWS } from "./importCsv";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

// Field splitting (RFC 4180).
check("plain fields are trimmed", JSON.stringify(csvRecords(" a , 1 ,2 ")[0].cells) === JSON.stringify(["a", "1", "2"]));
check("a quoted comma stays in its field", csvRecords('"Import, Cat",3,5')[0].cells[0] === "Import, Cat");
check("doubled quotes are a literal quote", csvRecords('"Say ""hi""",1')[0].cells[0] === 'Say "hi"');
check("a quoted line break stays in its field and lines are counted",
  (() => { const r = csvRecords('"two\nlines",1\nnext,2'); return r.length === 2 && r[0].cells[0] === "two\nlines" && r[1].line === 3; })());
check("CRLF and blank lines are handled", csvRecords("a,1\r\n\r\nb,2\r\n").length === 2);

// Numbers.
check("$1,200.50 is one amount", parseDollars("$1,200.50") === 120050);
check("1200 and 25 are amounts", parseDollars("1200") === 120000 && parseDollars("25") === 2500);
check("a malformed thousands group is not an amount", parseDollars("1,20") === null && parseDollars("12,0000") === null);
check("text is not an amount", parseDollars("ten") === null && parseDollars("") === null);
check("spins are whole numbers, thousands allowed", parseSpins("1,000") === 1000 && parseSpins("2.5") === null && parseSpins("-3") === -3);

// QA b5 m4 rows.
{
  const r = parseFanCsv('name,spins,amount\nCarol,-3,2\n"Import, Cat",4,10\nDana,2,"$1,200"\nEve,1,$1,200\nFinn,1,-5\nGus,abc\nHal,2.5');
  check("the header is skipped", r.skippedHeader);
  check("negative spins are rejected with a clear row error", r.errors.some((e) => /^Line 2 \(Carol\): spins can't be negative/.test(e)) && !r.rows.some((row) => row.name === "Carol"));
  check("a quoted name with a comma imports whole", r.rows.some((row) => row.name === "Import, Cat" && row.spins === 4 && row.amountCents === 1000));
  check("a quoted $1,200 is $1,200", r.rows.find((row) => row.name === "Dana")?.amountCents === 120000);
  check("an unquoted $1,200 is $1,200, not split", r.rows.find((row) => row.name === "Eve")?.amountCents === 120000);
  check("a negative amount is rejected", r.errors.some((e) => /^Line 6 \(Finn\): amount can't be negative/.test(e)) && !r.rows.some((row) => row.name === "Finn"));
  check("bad and fractional spins are rejected", r.errors.some((e) => /Gus.*whole number/.test(e)) && r.errors.some((e) => /Hal.*whole number/.test(e)));
  check("exactly the valid rows import", r.rows.map((row) => row.name).join("|") === "Import, Cat|Dana|Eve");
}
{
  const r = parseFanCsv("Ann,3\n@ann,2\nBob,1", ["Bob", "Zed"]);
  check("no header when the first row has spins", !r.skippedHeader && r.rows.length === 3);
  check("a duplicate name in the file is warned about (handle @ and case ignored)", r.warnings.some((w) => /^Line 2 \(@ann\): same name as line 1/.test(w)));
  check("a name that matches an existing fan is warned about", r.warnings.some((w) => /Line 3 \(Bob\): you already have a fan named “Bob”/.test(w)));
  check("warnings don't drop rows", r.errors.length === 0);
}
{
  const r = parseFanCsv('A,1,2,3,4');
  check("extra columns are an error that says how to quote", r.rows.length === 0 && /expected name, spins, amount/.test(r.errors[0]));
  const missing = parseFanCsv(",3");
  check("a missing name is an error", /missing name/.test(missing.errors[0] ?? ""));
}
{
  const many = Array.from({ length: MAX_IMPORT_ROWS + 3 }, (_, i) => `fan${i},1`).join("\n");
  const r = parseFanCsv(many);
  check("the row cap holds and is announced", r.rows.length === MAX_IMPORT_ROWS && r.warnings.some((w) => /cap reached/.test(w)));
}
console.log(`importCsv.test: ${passed} checks passed`);
