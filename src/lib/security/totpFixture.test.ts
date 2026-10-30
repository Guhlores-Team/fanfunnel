import assert from "node:assert/strict";
import { fixtureTotp } from "../../../scripts/security/totp-fixture.mjs";
// RFC6238 Appendix B, SHA1, secret ASCII 12345678901234567890 in base32.
const secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
let count=0;
for(const [seconds,expected] of [[59,"94287082"],[1111111109,"07081804"],[1111111111,"14050471"],[1234567890,"89005924"],[2000000000,"69279037"],[20000000000,"65353130"]] as const) {
 assert.equal(fixtureTotp(secret,seconds*1000,8),expected);count++;
 assert.equal(fixtureTotp(secret,seconds*1000),expected.slice(-6));count++;
}
for(const input of ["secret-with-private-characters","",null]) {
 assert.throws(()=>fixtureTotp(input as string),error=>error instanceof Error&&error.message==="invalid TOTP fixture input");count++;
}
console.log(`TOTP fixture RFC vectors: ${count} checks passed`);
