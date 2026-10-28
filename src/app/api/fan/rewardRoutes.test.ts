import assert from "node:assert";
import { POST as rewardPOST } from "./reward/route";
import { POST as spinPOST } from "../spin/route";
import { GET as deliveryGET, PUT as deliveryPUT } from "../prizes/[id]/reward/route";
import { POST as codesPOST } from "../prizes/[id]/codes/route";
import {
  mockAckFan,
  mockCreatePass,
  mockGetFanPass,
  mockGetOverview,
  mockGetPublicWheelTeaser,
  mockGetWheel,
  mockSaveWheel,
  mockSelfExclude,
  mockSetFanBlocked,
} from "@/lib/data/mock";
import { REWARD_VIEW_LIMIT } from "@/lib/rewards/config";
import type { Prize, WheelConfig } from "@/lib/games/wheel/types";

// #26 route-level tests on the demo (mock) data path, which follows the same
// rules as the Supabase path. The fan's link token is the only credential:
//   - bad bodies are 400; an unknown token or another fan's win is 404 (no
//     oracle for share ids); a paused or blocked link is 403;
//   - replaying the reveal returns the same reward and logs every view; it
//     never hands out a new code;
//   - the reveal is rate-limited per IP + token;
//   - the value never reaches the fan page payload, the public teaser, or
//     another fan; responses are no-store;
//   - the creator routes validate input, never echo a code in full, and a
//     code prize's stock (= codes left) and delivery can't be changed by
//     saving the wheel.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const req = (url: string, body: unknown, method = "POST", raw?: string) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const reveal = (body: unknown, raw?: string) => rewardPOST(req("/api/fan/reward", body, "POST", raw));
const spin = (token: string) => spinPOST(req("/api/spin", { token, clientSeed: "seed" }));
const putDelivery = (id: string, body: unknown) => deliveryPUT(req(`/api/prizes/${id}/reward`, body, "PUT"), params(id));
const getDelivery = (id: string) => deliveryGET(req(`/api/prizes/${id}/reward`, null, "GET"), params(id));
const postCodes = (id: string, codes: unknown) => codesPOST(req(`/api/prizes/${id}/codes`, { codes }), params(id));

function liveFan(name: string) {
  const f = mockCreatePass(name, 10);
  mockAckFan(f.token);
  return f;
}

const CODES = ["GIFT-AAAA-0001", "GIFT-BBBB-0002", "GIFT-CCCC-0003"];

async function main() {
  // A wheel where only the code prize can be won (the others have 0 tickets),
  // then a fallback once it sells out.
  const original = mockGetWheel();
  const codePrize: Prize = { id: "rw-code", label: "Unlock code", rarity: "epic", weight: 1, stock: null };
  const linkPrize: Prize = { id: "rw-link", label: "VIP link", rarity: "rare", weight: 0, stock: null };
  const plain: Prize = { id: "rw-plain", label: "Shout-out", rarity: "common", weight: 0, stock: null };
  const base: WheelConfig = { ...original, prizes: [codePrize, linkPrize, plain] };
  mockSaveWheel(base);

  // --- creator: delivery setup --------------------------------------------------------
  check("codes: empty paste is 400", (await postCodes("rw-code", "  \n ")).status === 400);
  check("codes: a non-string is 400", (await postCodes("rw-code", ["A"])).status === 400);
  check("codes: an over-long code refuses the paste", (await postCodes("rw-code", "x".repeat(500))).status === 400);
  check("codes: unknown prize is 404", (await postCodes("nope", "ABC")).status === 404);
  const added = await postCodes("rw-code", [...CODES, CODES[0]].join("\n"));
  const addedBody = (await added.json()) as { delivery: { codesLeft: number; preview: string[]; delivery: string }; added: number; duplicates: number };
  check("codes: 200, no-store", added.status === 200 && added.headers.get("cache-control") === "no-store");
  check("codes: 3 added, the repeat dropped", addedBody.added === 3 && addedBody.duplicates === 1 && addedBody.delivery.codesLeft === 3);
  check("codes: the prize is now a code list", addedBody.delivery.delivery === "codes");
  check("codes: the response never contains a full code", !CODES.some((c) => JSON.stringify(addedBody).includes(c)));
  check("codes: masked preview shows only the last 4", addedBody.delivery.preview.every((m) => /^••••\d{4}$/.test(m)));
  check("codes: stock = codes left on the editor's wheel", mockGetWheel().prizes.find((p) => p.id === "rw-code")?.stock === 3);

  for (const [label, body] of [
    ["http link", { kind: "link", value: "http://example.com" }],
    ["javascript link", { kind: "link", value: "javascript:alert(1)" }],
    ["empty text", { kind: "text", value: "  " }],
    ["unknown kind", { kind: "photo", value: "x" }],
    ["codes via PUT", { kind: "codes", value: "x" }],
  ] as const) {
    check(`delivery PUT: ${label} is 400`, (await putDelivery("rw-link", body)).status === 400);
  }
  const link = await putDelivery("rw-link", { kind: "link", value: "https://example.com/vip" });
  check("delivery PUT: an https link is saved", link.status === 200 && ((await link.json()) as { delivery: { delivery: string } }).delivery.delivery === "link");
  const got = (await (await getDelivery("rw-link")).json()) as { delivery: { value: string } };
  check("delivery GET: the creator sees their own link back", got.delivery.value === "https://example.com/vip");

  // Saving the wheel can't change delivery or a code prize's stock.
  const stale: WheelConfig = {
    ...mockGetWheel(),
    prizes: mockGetWheel().prizes.map((p) =>
      p.id === "rw-code" ? { ...p, stock: 99, delivery: "manual" } : p.id === "rw-plain" ? { ...p, delivery: "codes" } : p,
    ),
  };
  const saved = mockSaveWheel(stale);
  check("save: a code prize keeps stock = codes left", saved.prizes.find((p) => p.id === "rw-code")?.stock === 3);
  check("save: delivery comes from the server, not the editor", saved.prizes.find((p) => p.id === "rw-code")?.delivery === "codes" && saved.prizes.find((p) => p.id === "rw-plain")?.delivery === "manual");

  // --- fan: win + reveal ------------------------------------------------------------------
  const a = liveFan("Reward A");
  const b = liveFan("Reward B");
  const spinA = await spin(a.token);
  const winA = (await spinA.json()) as { prize: Record<string, unknown>; shareId: string; reward?: { kind: string; value: string } };
  check("spin: 200 with no-store", spinA.status === 200 && spinA.headers.get("cache-control") === "no-store");
  check("spin: the winner gets a code in the response", winA.reward?.kind === "code" && CODES.includes(winA.reward.value));
  check("spin: the prize object itself carries no reward or delivery", !("reward" in winA.prize) && !("delivery" in winA.prize));
  const spinB = await spin(b.token);
  const winB = (await spinB.json()) as { shareId: string; reward?: { value: string } };
  check("spin: another winner gets a different code", !!winB.reward && winB.reward.value !== winA.reward?.value);

  const pageA = await mockGetFanPass(a.token);
  const pageJson = JSON.stringify(pageA);
  check("fan page: the win is flagged instant", pageA?.recentWins.some((w) => w.shareId === winA.shareId && w.instant === true) === true);
  check("fan page: no code value anywhere in the payload", !CODES.some((c) => pageJson.includes(c)));
  check("fan page: no reward/delivery field on any prize", !/"delivery"|"reward"|cipher/.test(JSON.stringify(pageA?.wheel)));
  const teaser = JSON.stringify(mockGetPublicWheelTeaser("demo-creator"));
  check("public teaser: no delivery, reward or link", !/delivery|reward|example\.com\/vip/.test(teaser) && !CODES.some((c) => teaser.includes(c)));

  // Bad input.
  for (const [label, call] of [
    ["not JSON", () => reveal(undefined, "nope")],
    ["no token", () => reveal({ shareId: winA.shareId })],
    ["a non-string token", () => reveal({ token: { $ne: null }, shareId: winA.shareId })],
    ["no share id", () => reveal({ token: a.token })],
    ["a share id with odd characters", () => reveal({ token: a.token, shareId: "../../x" })],
    ["an oversized share id", () => reveal({ token: a.token, shareId: "s".repeat(100) })],
  ] as const) {
    check(`reveal: ${label} is 400`, (await call()).status === 400);
  }
  check("reveal: an unknown token is 404", (await reveal({ token: "nope-" + Date.now(), shareId: winA.shareId })).status === 404);
  check("reveal: another fan's win is 404 (B's token, A's share id)", (await reveal({ token: b.token, shareId: winA.shareId })).status === 404);
  check("reveal: an unknown share id is 404", (await reveal({ token: a.token, shareId: "share_unknown" })).status === 404);

  const r1 = await reveal({ token: a.token, shareId: winA.shareId });
  const v1 = (await r1.json()) as { reward: { value: string }; views: number };
  check("reveal: 200, no-store, the same code as the win card", r1.status === 200 && r1.headers.get("cache-control") === "no-store" && v1.reward.value === winA.reward?.value);
  check("reveal: the view is logged (win card = 1, this = 2)", v1.views === 2);
  const r2 = (await (await reveal({ token: a.token, shareId: winA.shareId })).json()) as { reward: { value: string }; views: number };
  check("reveal replay: same code again, never a new one", r2.reward.value === winA.reward?.value && r2.views === 3);
  check("reveal replay: no code was consumed by re-viewing", mockGetWheel().prizes.find((p) => p.id === "rw-code")?.stock === 1);
  const auto = mockGetOverview().redemptions.find((r) => r.auto && r.status === "fulfilled" && r.auto.views === 3);
  check("fulfilment: the win is fulfilled, tagged Auto, with 3 views", !!auto && auto.auto?.kind === "code");
  check("fulfilment: the queue never carries the value", !CODES.some((c) => JSON.stringify(mockGetOverview()).includes(c)));

  // A manual win has nothing to reveal.
  const c = liveFan("Reward C");
  await spin(c.token); // takes the last code
  mockSaveWheel({ ...mockGetWheel(), prizes: mockGetWheel().prizes.map((p) => (p.id === "rw-plain" ? { ...p, weight: 5 } : p)) });
  const plainWin = (await (await spin(c.token)).json()) as { prize: { id: string }; shareId: string; reward?: unknown };
  check("out of codes: the code prize is never awarded (sold out)", plainWin.prize.id === "rw-plain" && plainWin.reward === undefined);
  check("reveal: a manual win's share id is 404", (await reveal({ token: c.token, shareId: plainWin.shareId })).status === 404);

  // Paused / blocked links.
  const p = liveFan("Reward Paused");
  mockSaveWheel({ ...mockGetWheel(), prizes: mockGetWheel().prizes.map((x) => ({ ...x, weight: x.id === "rw-link" ? 1 : 0 })) });
  const pWin = (await (await spin(p.token)).json()) as { shareId: string; reward?: { kind: string; value: string } };
  check("link prize: the winner gets the link", pWin.reward?.kind === "link" && pWin.reward.value === "https://example.com/vip");
  mockSelfExclude(p.token);
  check("reveal: a paused link is 403", (await reveal({ token: p.token, shareId: pWin.shareId })).status === 403);
  const bl = liveFan("Reward Blocked");
  const blWin = (await (await spin(bl.token)).json()) as { shareId: string };
  mockSetFanBlocked(bl.fanId, true);
  check("reveal: a blocked fan's link is 403", (await reveal({ token: bl.token, shareId: blWin.shareId })).status === 403);
  mockSetFanBlocked(bl.fanId, false);

  // Rate limit per IP + token (rejected requests count too).
  const lim = liveFan("Reward Limited");
  let last = 200;
  for (let i = 0; i < REWARD_VIEW_LIMIT + 1; i++) last = (await reveal({ token: lim.token, shareId: "share_none" })).status;
  check(`reveal: request ${REWARD_VIEW_LIMIT + 1} in a minute is 429`, last === 429);

  // Switching a code list to manual drops unused codes; stock stays a plain limit.
  await postCodes("rw-code", "LATE-0000-0009");
  const man = (await (await putDelivery("rw-code", { kind: "manual" })).json()) as { delivery: { delivery: string; codesLeft: number } };
  check("manual again: delivery manual, no codes left", man.delivery.delivery === "manual" && man.delivery.codesLeft === 0);
  check("manual again: stock keeps the count as an ordinary limit", mockGetWheel().prizes.find((x) => x.id === "rw-code")?.stock === 1);

  mockSaveWheel(original);
  console.log(`fan reward routes: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
