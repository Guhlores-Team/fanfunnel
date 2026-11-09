import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL } from "./legal";

// T19: public/.well-known/security.txt (RFC 9116) names the one contact the
// Terms and Privacy Policy already publish, and has not expired. An expired
// file is invalid, so this fails when it is time to renew it.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const text = readFileSync(join(import.meta.dirname, "../../public/.well-known/security.txt"), "utf8");
const field = (name: string) => text.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim();
check("Contact is the published contact address", field("Contact") === `mailto:${LEGAL.contactEmail}`);
const expires = Date.parse(field("Expires") ?? "");
check("Expires is a valid date", Number.isFinite(expires));
check("Expires is in the future (renew the file when this fails)", expires > Date.now());
check("Expires is at most a year and a bit out", expires - Date.now() < 400 * 86_400_000);
check("Preferred-Languages is English", field("Preferred-Languages") === "en");
check("no other address is invented", (text.match(/@/g) ?? []).length === 1);
console.log(`securityTxt.test: ${passed} checks passed`);
