import assert from "node:assert";
import { shareOrCopy, type ShareEnv } from "./shareLink";

const data = { title: "Spin link for @mia", text: "Your personal link, @mia:", url: "https://x.test/spin/abc" };
const copies: string[] = [];
const copy = async (t: string) => { copies.push(t); return true; };

(async () => {
  const shared: ShareData[] = [];
  assert.equal(await shareOrCopy(data, { share: async (d) => { shared.push(d); }, copy }), "shared", "Web Share used when present");
  assert.equal(shared[0].url, data.url);
  assert.equal(copies.length, 0, "sharing copies nothing");

  const abort = Object.assign(new Error("cancel"), { name: "AbortError" });
  assert.equal(await shareOrCopy(data, { share: async () => { throw abort; }, copy }), "cancelled", "closing the sheet is not an error");
  assert.equal(copies.length, 0, "a cancelled share copies nothing");

  assert.equal(await shareOrCopy(data, { copy }), "copied", "no Web Share: clipboard fallback");
  assert.equal(copies.at(-1), data.url);

  const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
  assert.equal(await shareOrCopy(data, { share: async () => { throw denied; }, copy }), "copied", "a refused share falls back to copying");

  assert.equal(await shareOrCopy(data, { share: async () => {}, canShare: () => false, copy }), "copied", "canShare false: copy");

  const env: ShareEnv = { copy: async () => false };
  assert.equal(await shareOrCopy(data, env), "failed", "no share and no clipboard: failed");
  console.log("shareLink: all checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
