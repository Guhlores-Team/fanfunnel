import assert from "node:assert/strict";

// I3: reading a thread (GET, which a cross-site top-level link can trigger
// under SameSite=Lax) never marks anything read; the Inbox marks read with
// its own POST. Demo store, through the real route handlers.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

async function main() {
  const m = await import("@/lib/data/mock");
  const { GET, POST } = await import("./[fanId]/route");
  const fan = m.mockCreatePass("Thread Fan", 3);
  m.mockAckFan(fan.token);
  check("the fan's message is stored", "ok" in m.mockSendFanMessage(fan.token, "hello creator"));
  const unread = () => m.mockListThreads().find((t) => t.fanId === fan.fanId)?.unread ?? -1;
  check("it starts unread", unread() === 1);

  let ip = 0;
  const req = (method: string) =>
    new Request(`http://localhost/api/messages/thread/${fan.fanId}`, { method, headers: { "x-real-ip": `198.51.100.${++ip}` } });
  const ctx = { params: Promise.resolve({ fanId: fan.fanId }) };

  for (let i = 0; i < 3; i++) {
    const res = await GET(req("GET"), ctx);
    check(`GET ${i + 1} reads the thread`, res.status === 200 && (await res.json()).messages.some((x: { body: string }) => x.body === "hello creator"));
  }
  check("GET never marks the thread read", unread() === 1);
  const res = await POST(req("POST"), ctx);
  check("POST marks it read", res.status === 200 && (await res.json()).ok === true && unread() === 0);
  check("the next GET shows it read", (await (await GET(req("GET"), ctx)).json()).messages.every((x: { sender: string; readAt: string | null }) => x.sender !== "fan" || x.readAt));
  const seat = await POST(new Request(`http://localhost/api/messages/thread/${fan.fanId}?creatorId=someone-else`, { method: "POST" }), ctx);
  check("demo: a seat creatorId is refused like GET", seat.status >= 400 && seat.status < 500);
  console.log(`thread read: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
