import assert from "node:assert";
import { fingerprint, normalizeMessage, topFrame } from "./fingerprint";

// Grouping: the same bug must land on ONE row (count goes up) across
// deploys, line shifts and varying ids; different bugs must not merge.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  const v8 = (file: string, line: number, col: number) =>
    `TypeError: Cannot read properties of undefined (reading 'map')\n    at WheelList (https://fanfunnel.app/_next/static/chunks/${file}.js:${line}:${col})\n    at renderWithHooks (https://fanfunnel.app/_next/static/chunks/framework.js:1:1)`;

  const a = await fingerprint({ message: "TypeError: Cannot read properties of undefined (reading 'map')", stack: v8("app-1a2b3c4d5e6f", 1, 2345), source: "client" });
  const b = await fingerprint({ message: "TypeError: Cannot read properties of undefined (reading 'map')", stack: v8("app-9f8e7d6c5b4a", 3, 99), source: "client" });
  check("fingerprint is 64 lowercase hex", /^[0-9a-f]{64}$/.test(a));
  check("same bug after a redeploy (new chunk hash, line, column) → same fingerprint", a === b);

  const c = await fingerprint({ message: "TypeError: x is not a function", stack: v8("app-1a2b3c4d5e6f", 1, 2345), source: "client" });
  check("a different message → a different fingerprint", a !== c);

  const d = await fingerprint({ message: "TypeError: Cannot read properties of undefined (reading 'map')", stack: v8("app-1a2b3c4d5e6f", 1, 2345), source: "server" });
  check("the same text from the server → a different fingerprint (source is part of it)", a !== d);

  const e = await fingerprint({
    message: "TypeError: Cannot read properties of undefined (reading 'map')",
    stack: "TypeError: Cannot read properties of undefined (reading 'map')\n    at FanTable (https://fanfunnel.app/_next/static/chunks/app.js:1:1)",
    source: "client",
  });
  check("same message thrown from another component → a different fingerprint", a !== e);

  const f1 = await fingerprint({ message: "Fan 42 has 3 spins left but needs 5", source: "server" });
  const f2 = await fingerprint({ message: "Fan 7 has 0 spins left but needs 1", source: "server" });
  check("numbers in the message do not split the group", f1 === f2);

  const g1 = await fingerprint({ message: "No pass for [uuid]", source: "server" });
  const g2 = await fingerprint({ message: "No pass for [redacted]", source: "server" });
  check("redaction placeholders group together", g1 === g2);

  check("normalizeMessage drops 'Uncaught' and collapses whitespace", normalizeMessage("Uncaught   Error:  boom\n here") === "Error: boom here");
  check("normalizeMessage masks hex runs", normalizeMessage("chunk deadbeef12 failed") === "chunk <hex> failed");

  check("topFrame: V8 frame without origin, line or column", topFrame("Error: x\n    at foo (https://a.b/x.js:10:20)") === "foo (/x.js)");
  check("topFrame: Gecko/WebKit frame", topFrame("foo@https://a.b/_next/x.js:10:20\nbar@https://a.b/y.js:1:1") === "foo@/_next/x.js");
  check("topFrame: query string on the file dropped", topFrame("Error\n    at f (https://a.b/c.js?v=123:1:2)") === "f (/c.js)");
  check("topFrame: no stack → empty", topFrame(undefined) === "" && topFrame("just a message") === "");

  console.log(`monitoring/fingerprint: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
