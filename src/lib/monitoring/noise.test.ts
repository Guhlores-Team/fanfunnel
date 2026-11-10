import assert from "node:assert/strict";
import { isNoise } from "./report";

// WA-03: the Vercel Toolbar's CSP block (vercel.live) is not an error; every
// anonymous Preview view used to report it and spend the client alert budget.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
check("the toolbar's script-src-elem block is noise", isNoise("CSP blocked script-src-elem: https://vercel.live"));
check("…and its script-src / connect forms", isNoise("CSP blocked script-src: https://vercel.live") && isNoise("CSP blocked connect-src: https://vercel.live/_next-live/feedback/feedback.js"));
check("a CSP block of another origin is still reported", !isNoise("CSP blocked script-src-elem: https://evil.example") && !isNoise("CSP blocked img-src: https://cdn.example/x.png"));
check("a real error mentioning the word is still reported", !isNoise("TypeError: cannot read properties of undefined (reading 'live')"));
console.log(`monitoring/noise: ${passed} checks passed`);
