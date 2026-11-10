import assert from "node:assert/strict";
import { publicTextCheck, publicTextMessage, MAX_PUBLIC_LABEL } from "./publicText";

// TS-04: links, bare domains, phone numbers and @handles are refused in
// public creator text; ordinary prize copy passes.
const ok = ["Spin to win 🎁", "Signed polaroid", "10% off next month", "Hey you 😘 spin away — every spin wins!", "Level 2 unlock", "Dinner for 2 at 8pm", "VIP · 1 of 5", "#1 fan badge", "Call me maybe (the song)", "2 for 1 night"];
for (const text of ok) assert.equal(publicTextCheck(text), null, `allowed: ${text}`);

assert.equal(publicTextCheck("DM me on telegram t.me/xxx")?.reason, "url");
assert.equal(publicTextCheck("Pay $20 at cash.app/xyz for VIP")?.reason, "url");
assert.equal(publicTextCheck("my real page https://example.com/me")?.reason, "url");
assert.equal(publicTextCheck("find me www.example.net")?.reason, "url");
assert.equal(publicTextCheck("call +1 555 123 4567")?.reason, "phone");
assert.equal(publicTextCheck("text (555) 123-4567 now")?.reason, "phone");
assert.equal(publicTextCheck("follow @my_other_account")?.reason, "handle");
assert.equal(publicTextCheck("email me at me@example.com")?.reason, "url");
assert.equal(publicTextCheck("you retard")?.reason, "slur");
assert.equal(publicTextCheck(""), null);
assert.equal(publicTextCheck(undefined), null);
assert.match(publicTextMessage({ reason: "url", match: "t.me/xxx" }, "A prize name"), /t\.me\/xxx/);
assert.equal(MAX_PUBLIC_LABEL, 80);
console.log("publicText: ok");
