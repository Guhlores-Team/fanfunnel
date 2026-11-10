import assert from "node:assert";
import { mock } from "node:test";

// RD-19: a conversation is read one page at a time (newest first), with
// `before` for the older pages, so a long thread never silently loses its
// start. PR-10: the delivery promise is a whole number of days or null.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => false,
    createClient: async () => {
      throw new Error("demo mode must not open a Supabase client");
    },
    createServiceClient: () => {
      throw new Error("the inbox must not use the service role");
    },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });

async function main() {
  const data = await import("./index");
  const m = await import("./mock");
  const thread = await import("@/app/api/messages/thread/[fanId]/route");
  const profile = await import("@/app/api/public-profile/route");

  const fan = m.mockCreatePass("Thread Page Fan", 1);
  m.mockAckFan(fan.token);
  for (let i = 0; i < 7; i++) {
    assert.ok("ok" in m.mockSendCreatorMessage(fan.fanId, `m${i}`));
    await new Promise((r) => setTimeout(r, 2));
  }
  const all = m.mockGetThread(fan.fanId);
  const bodies = (list: { body: string }[]) => list.map((x) => x.body).filter((b) => /^m\d$/.test(b)).join(",");

  const first = await data.getThreadPage(fan.fanId, undefined, { limit: 3 });
  assert.ok(!("error" in first));
  check("the first page is the newest messages, oldest first", bodies(first.messages) === "m4,m5,m6" && first.more === true);
  const second = await data.getThreadPage(fan.fanId, undefined, { limit: 3, before: first.messages[0].at });
  assert.ok(!("error" in second));
  check("`before` continues with the older ones", bodies(second.messages) === "m1,m2,m3" && second.more === true);
  const third = await data.getThreadPage(fan.fanId, undefined, { limit: 500, before: second.messages[0].at });
  assert.ok(!("error" in third));
  check("the last page says there is no more", third.more === false && third.messages.length === all.length - 6);
  check("pages never overlap and cover the thread", [...third.messages, ...second.messages, ...first.messages].map((x) => x.id).join() === all.map((x) => x.id).join());
  const bad = await data.getThreadPage(fan.fanId, undefined, { before: "yesterday" });
  check("a `before` that is no date is refused", "error" in bad && bad.error === "bad_request");
  const whole = await data.getThread(fan.fanId);
  check("getThread still answers the newest page as a list", Array.isArray(whole) && whole.length === all.length);

  const params = { params: Promise.resolve({ fanId: fan.fanId }) };
  const get = (qs: string) => thread.GET(new Request(`http://localhost/api/messages/thread/${fan.fanId}${qs}`), params);
  const res = await get("?limit=2");
  const page = (await res.json()) as { messages: { body: string }[]; more: boolean };
  check("the route answers { messages, more }", res.status === 200 && page.messages.length === 2 && page.more === true);
  check("limit must be 1..500", (await get("?limit=0")).status === 400 && (await get("?limit=501")).status === 400 && (await get("?limit=2.5")).status === 400);
  check("an unparsable before is a 400", (await get("?before=nope")).status === 400);
  check("an oversized before is a 400", (await get(`?before=${"1".repeat(41)}`)).status === 400);

  // --- PR-10 ---------------------------------------------------------------------
  const put = (body: unknown) => profile.PUT(new Request("http://localhost/api/public-profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const read = async () => (await (await profile.GET(new Request("http://localhost/api/public-profile"))).json()) as { deliveryDays?: number | null };
  check("no promise by default", (await read()).deliveryDays === null);
  for (const bad of [0, 61, 2.5, "3", -1]) {
    const r = await put({ deliveryDays: bad });
    check(`deliveryDays ${JSON.stringify(bad)} is refused`, r.status === 400 && ((await r.json()) as { error: string }).error === "invalid_delivery_days");
  }
  check("a whole number of days saves", (await put({ deliveryDays: 5 })).status === 200 && (await read()).deliveryDays === 5);
  check("a save without the key leaves the promise alone", (await put({ tagline: "kept" })).status === 200 && (await read()).deliveryDays === 5);
  check("null clears it", (await put({ deliveryDays: null })).status === 200 && (await read()).deliveryDays === null);

  const due = await import("@/lib/dueDate");
  check("the expected-by day is the win's local day plus the promise", due.localDayPlus(5, new Date(2026, 10, 28, 23, 30).getTime()) === "2026-12-03");
  check("a due day gets a short label, anything else passes through", /3/.test(due.dueDayLabel("2026-12-03")) && due.dueDayLabel("soon") === "soon");

  console.log(`threadPage.test.ts: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
