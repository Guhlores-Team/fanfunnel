import assert from "node:assert";
import { clientIp } from "./clientIp";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const req = (headers: Record<string, string>) =>
  new Request("https://x.test/api/spin", { headers });

// Trusted proxy headers win over the spoofable XFF.
check(
  "x-real-ip preferred over x-forwarded-for",
  clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" })) === "9.9.9.9",
);
check(
  "cf-connecting-ip preferred over x-forwarded-for",
  clientIp(req({ "cf-connecting-ip": "8.8.8.8", "x-forwarded-for": "1.2.3.4" })) === "8.8.8.8",
);
check(
  "x-real-ip preferred over cf-connecting-ip",
  clientIp(req({ "x-real-ip": "9.9.9.9", "cf-connecting-ip": "8.8.8.8" })) === "9.9.9.9",
);

// XFF is only a fallback, and is trimmed.
check(
  "falls back to first x-forwarded-for hop",
  clientIp(req({ "x-forwarded-for": " 5.6.7.8 , 10.0.0.1" })) === "5.6.7.8",
);

// No usable header → stable sentinel (never throws).
check("no headers -> local", clientIp(req({})) === "local");
check(
  "blank x-real-ip falls through to xff",
  clientIp(req({ "x-real-ip": "   ", "x-forwarded-for": "5.6.7.8" })) === "5.6.7.8",
);

console.log(`clientIp.test: ${passed} checks passed`);
