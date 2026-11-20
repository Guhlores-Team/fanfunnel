import assert from "node:assert/strict";
import { csvCell, csvHeaders, toCsv } from "./csv";

// PR-07: spreadsheet exports never carry a formula.
assert.equal(csvCell("plain"), '"plain"');
assert.equal(csvCell('say "hi"'), '"say ""hi"""', "quotes are doubled");
assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"", "a formula cell is prefixed with an apostrophe");
for (const lead of ["+1", "-2", "@cmd", "\tx", "\rx"]) assert.ok(csvCell(lead).startsWith("\"'"), `${JSON.stringify(lead)} is neutralised`);
assert.equal(csvCell(null), '""');
assert.equal(csvCell(12.5), '"12.5"');
assert.equal(toCsv([["a", "b"], [1, "=x"]]), '﻿"a","b"\r\n"1","\'=x"\r\n', "BOM, CRLF, every cell quoted");
const h = csvHeaders("fans 2026/11.csv");
assert.equal(h["Content-Disposition"], 'attachment; filename="fans_2026_11.csv"', "the file name is sanitised");
assert.match(h["Content-Type"], /text\/csv/);
console.log("csv: ok");
