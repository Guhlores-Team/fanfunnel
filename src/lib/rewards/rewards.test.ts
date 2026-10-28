import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { openReward, rewardCryptoReady, sealReward } from "./crypto";
import {
  codeHint,
  maskCode,
  normalizeRewardLink,
  normalizeRewardText,
  parseCodeList,
  rewardReviewAllowed,
  REWARD_REVIEW,
  MAX_CODE_LENGTH,
  MAX_REWARD_TEXT,
} from "./config";

// #26: reward encryption (AES-256-GCM, server-only key) and the shared rules.
// Plus a static guard: nothing that touches a decrypted reward may log it.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}
const throws = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e instanceof Error ? e.message : String(e));
  }
};

// --- crypto ------------------------------------------------------------------------
// Throwaway keys generated per run; never a real key.
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
delete process.env.REWARD_ENCRYPTION_KEY_VERSION;

delete process.env.REWARD_ENCRYPTION_KEY;
check("no key: not ready", !rewardCryptoReady());
check("no key: sealing fails closed", throws(() => sealReward("x", "c1"), /reward_key_missing/));
process.env.REWARD_ENCRYPTION_KEY = randomBytes(16).toString("base64");
check("a 16-byte key is refused (needs 32)", !rewardCryptoReady());
process.env.REWARD_ENCRYPTION_KEY = "not base64 at all!!";
check("a garbage key is refused", !rewardCryptoReady());

process.env.REWARD_ENCRYPTION_KEY = KEY_A;
check("a 32-byte key is ready", rewardCryptoReady());
const sealed = sealReward("VIP-7F2K-0042", "creator-1");
check("round trip", openReward(sealed, "creator-1") === "VIP-7F2K-0042");
check("ciphertext never contains the value", !sealed.cipher.includes("VIP") && !Buffer.from(sealed.cipher, "base64").toString("utf8").includes("VIP-7F2K"));
check("key version defaults to 1", sealed.keyVersion === 1);
const again = sealReward("VIP-7F2K-0042", "creator-1");
check("a fresh IV per value (same plaintext, different ciphertext)", again.iv !== sealed.iv && again.cipher !== sealed.cipher);

const flip = (b64: string, at: number) => {
  const buf = Buffer.from(b64, "base64");
  buf[at] ^= 0x01;
  return buf.toString("base64");
};
check("a tampered ciphertext fails", throws(() => openReward({ ...sealed, cipher: flip(sealed.cipher, 0) }, "creator-1"), /./));
check("a tampered tag fails", throws(() => openReward({ ...sealed, cipher: flip(sealed.cipher, Buffer.from(sealed.cipher, "base64").length - 1) }, "creator-1"), /./));
check("a tampered IV fails", throws(() => openReward({ ...sealed, iv: flip(sealed.iv, 0) }, "creator-1"), /./));
check("another creator's id fails (no moving a code between creators)", throws(() => openReward(sealed, "creator-2"), /./));
check("a wrong key version fails", throws(() => openReward({ ...sealed, keyVersion: 2 }, "creator-1"), /reward_key_version/));
process.env.REWARD_ENCRYPTION_KEY = KEY_B;
check("the wrong key fails", throws(() => openReward(sealed, "creator-1"), /./));
process.env.REWARD_ENCRYPTION_KEY_VERSION = "2";
const v2 = sealReward("rotated", "creator-1");
check("a rotated key writes its version", v2.keyVersion === 2 && openReward(v2, "creator-1") === "rotated");
check("an old-version value is refused, not mis-decrypted", throws(() => openReward(sealed, "creator-1"), /reward_key_version/));
delete process.env.REWARD_ENCRYPTION_KEY_VERSION;
delete process.env.REWARD_ENCRYPTION_KEY;
check("decrypting without a key fails closed", throws(() => openReward(sealed, "creator-1"), /reward_key_missing/));

// --- rules ---------------------------------------------------------------------------
check("https link accepted", normalizeRewardLink(" https://example.com/vip?x=1 ") === "https://example.com/vip?x=1");
for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,hi", "https://user:pw@example.com", "ftp://x", "", "   ", 42, null, "https://" + "a".repeat(3000) + ".com"]) {
  check(`link refused: ${String(bad).slice(0, 30)}`, normalizeRewardLink(bad) === null);
}
check("text trimmed", normalizeRewardText("  hi  ") === "hi");
check("empty text refused", normalizeRewardText("   ") === null);
check("over-long text refused", normalizeRewardText("x".repeat(MAX_REWARD_TEXT + 1)) === null);
check("max-length text accepted", normalizeRewardText("x".repeat(MAX_REWARD_TEXT)) !== null);

const parsed = parseCodeList("AAA-111\n\n  BBB-222  \r\nAAA-111\n" + "Z".repeat(MAX_CODE_LENGTH + 1) + "\nCCC-333");
check("codes: one per line, trimmed, blank lines ignored", parsed.codes.join(",") === "AAA-111,BBB-222,CCC-333");
check("codes: repeats in a paste are dropped and counted", parsed.duplicates === 1);
check("codes: over-long lines are counted (the route refuses the paste)", parsed.tooLong === 1);
check("codes: a non-string paste is empty", parseCodeList(undefined).codes.length === 0);
check("hint: last 4 of an 8+ character code", codeHint("ABCD-7F2K") === "7F2K");
check("hint: none for a short code", codeHint("AB12") === null && codeHint("1234567") === null);
check("mask with hint", maskCode("7F2K") === "••••7F2K");
check("mask without hint", maskCode(null) === "••••••");

check("D7 default is 'always' (reopen any time, views logged)", REWARD_REVIEW === "always");
const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
const day = 86_400_000;
check("always: allowed a year later", rewardReviewAllowed(at, "always", Date.parse(at) + 365 * day));
check("once: never reopened", !rewardReviewAllowed(at, "once", Date.parse(at) + 1000));
check("30 days: allowed on day 29", rewardReviewAllowed(at, { days: 30 }, Date.parse(at) + 29 * day));
check("30 days: refused on day 31", !rewardReviewAllowed(at, { days: 30 }, Date.parse(at) + 31 * day));

// --- static: decrypted values never reach a log ---------------------------------------
// Every console call in a module that seals/opens rewards may only log fixed
// text, an error message/code or a prize id, never a variable that could hold
// a value (value, plain, reward, code, delivered, sealed, input, codes, body).
const SRC = join(import.meta.dirname, "../..");
function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(e) && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
const touching = files(SRC).filter((f) => /\b(openReward|sealReward|getFanReward|reserveRewardCode|loadPrizeReward|mockGetFanReward|mockTakeReward)\b/.test(readFileSync(f, "utf8")));
check("found the modules that handle reward values", touching.length >= 5);
// An identifier (not a property such as error.code) named like a secret holder.
const SECRET = /(?<![.\w])(value|plain|reward|delivered|sealed|input|codes|body|code)\b(?!\.(status|length))/;
const leaks: string[] = [];
for (const f of touching) {
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "console"
    ) {
      for (const a of n.arguments) {
        if (ts.isStringLiteralLike(a)) continue;
        if (SECRET.test(a.getText(sf))) leaks.push(`${f.slice(SRC.length)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${a.getText(sf)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
for (const l of leaks) console.error("  ✗ console call may log a reward:", l);
check("no console call logs a reward value", leaks.length === 0);
const cryptoSrc = readFileSync(join(SRC, "lib/rewards/crypto.ts"), "utf8");
check("crypto.ts is server-only (first statement)", /^import "server-only";/.test(cryptoSrc));
check("crypto.ts never logs", !/console\./.test(cryptoSrc));
check("the key is never a NEXT_PUBLIC_ variable", !/NEXT_PUBLIC_[A-Z_]*REWARD/.test(files(SRC).map((f) => readFileSync(f, "utf8")).join("\n")));

console.log(`rewards.test: ${passed} checks passed`);
