import assert from "node:assert";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A30: approving a creator leaves an in-app notice (the bell) and, when the
// Resend sender is configured, e-mails the account's own confirmed address.
// Only a real pending → approved transition notifies; a rejection, a repeat
// approval or a refused update does not; nothing the e-mail says identifies
// anyone; a failing notice or e-mail never undoes the approval.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const CREATOR = "cccccccc-0000-4000-8000-0000000000a3";
let before = "pending";
let updatedRow: unknown = { id: CREATOR };
let noticeError: { code: string } | null = null;
let user: { email?: string; email_confirmed_at?: string | null } | null = { email: "new.creator@example.com", email_confirmed_at: "2026-10-30T00:00:00Z" };
const notices: Record<string, unknown>[] = [];
const userLookups: string[] = [];
const after: (() => unknown)[] = [];
const sent: { to: string[]; subject: string; text: string; html: string }[] = [];
const realError = console.error;

function chain(table: string) {
  const ops: { name: string; args: unknown[] }[] = [];
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown) => {
          const insert = ops.find((o) => o.name === "insert");
          if (table === "creator_notices" && insert) {
            if (!noticeError) notices.push(insert.args[0] as Record<string, unknown>);
            return Promise.resolve({ data: null, error: noticeError }).then(res);
          }
          if (table === "profiles" && ops.some((o) => o.name === "update")) return Promise.resolve({ data: updatedRow, error: null }).then(res);
          if (table === "profiles") return Promise.resolve({ data: { approval_status: before }, error: null }).then(res);
          return Promise.resolve({ data: null, error: null }).then(res);
        };
      }
      return (...args: unknown[]) => { ops.push({ name: String(prop), args }); return proxy; };
    },
  });
  return proxy;
}
const client = () => ({
  from: chain,
  auth: {
    getUser: async () => ({ data: { user: { id: "admin-1" } }, error: null }),
    admin: { getUserById: async (id: string) => { userLookups.push(id); return { data: { user }, error: null }; } },
  },
});
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => client(), createServiceClient: () => client() } });
mock.module("@/lib/auth/adminCheck", { namedExports: { isActiveAdmin: async () => true, checkAdmin: async () => ({ status: "admin", userId: "admin-1" }) } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: (task: () => unknown) => void after.push(task) } });

async function main() {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://ff.example";
  process.env.VERCEL_ENV = "production";
  let accept = true;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === "https://api.resend.com/emails") sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: accept ? 200 : 500 });
  }) as unknown as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  const error = console.error;
  console.error = () => {};

  const { decideCreatorApplication } = await import("@/lib/data/admin");
  const flush = async () => { while (after.length) await after.shift()!(); };

  // --- pending → approved -------------------------------------------------------
  let r = await decideCreatorApplication(CREATOR, "approved");
  check("the approval succeeds", "ok" in r);
  check("one in-app notice is left for that creator", notices.length === 1 && notices[0].creator_id === CREATOR && notices[0].kind === "creator_approved");
  check("the notice carries no details", JSON.stringify(notices[0].details) === "{}");
  check("the e-mail is sent after the response, not inline", sent.length === 0 && after.length === 1);
  await flush();
  check("the e-mail goes to the account's own confirmed address only", sent.length === 1 && sent[0].to.join() === "new.creator@example.com" && userLookups.at(-1) === CREATOR);
  check("…says it is approved and links to the dashboard", /approved/i.test(sent[0].subject) && sent[0].text.includes("https://ff.example/dashboard"));
  check("…and names nobody (no address or id in the body)", !sent[0].text.includes("new.creator") && !sent[0].html.includes("new.creator") && !sent[0].text.includes(CREATOR));

  // --- no notification without a real transition --------------------------------
  notices.length = 0; sent.length = 0;
  before = "approved";
  r = await decideCreatorApplication(CREATOR, "approved");
  await flush();
  check("re-approving an approved account notifies nobody", "ok" in r && notices.length === 0 && sent.length === 0);
  before = "pending";
  r = await decideCreatorApplication(CREATOR, "rejected");
  await flush();
  check("a rejection leaves no approval notice or e-mail", "ok" in r && notices.length === 0 && sent.length === 0);
  updatedRow = null;
  r = await decideCreatorApplication(CREATOR, "approved");
  await flush();
  check("an update that changed no row notifies nobody", notices.length === 0 && sent.length === 0);
  updatedRow = { id: CREATOR };

  // --- failures never undo the approval -----------------------------------------
  noticeError = { code: "23514" };
  r = await decideCreatorApplication(CREATOR, "approved");
  check("a failed notice insert still approves", "ok" in r);
  noticeError = null;
  accept = false;
  after.length = 0;
  r = await decideCreatorApplication(CREATOR, "approved");
  let threw = false;
  try { await flush(); } catch { threw = true; }
  check("a refused e-mail still approves and never throws", "ok" in r && !threw);
  accept = true;

  // --- when the e-mail is skipped ----------------------------------------------
  const { sendApprovalEmail, buildApprovalEmail, dashboardUrl } = await import("./approvalNotice");
  const svc = client() as never;
  const cfg = { enabled: false, apiKey: "re_test_key", to: [], from: "FanFunnel <alerts@example.com>", environments: ["production"], maxPerHour: 10 };
  check("no Resend key → skipped", (await sendApprovalEmail(svc, CREATOR, { cfg: { ...cfg, apiKey: null }, environment: "production" })) === "skipped");
  check("local development → skipped", (await sendApprovalEmail(svc, CREATOR, { cfg, environment: "development" })) === "skipped");
  user = { email: "new.creator@example.com", email_confirmed_at: null };
  check("an unconfirmed address → skipped", (await sendApprovalEmail(svc, CREATOR, { cfg, environment: "production" })) === "skipped");
  user = null;
  check("no account → skipped", (await sendApprovalEmail(svc, CREATOR, { cfg, environment: "preview" })) === "skipped");
  user = { email: "new.creator@example.com", email_confirmed_at: "2026-10-30T00:00:00Z" };
  check("preview sends (to the TEST account's own address)", (await sendApprovalEmail(svc, CREATOR, { cfg, environment: "preview", send: async () => true })) === "sent");
  check("a throwing sender → failed, never thrown", (await sendApprovalEmail(svc, CREATOR, { cfg, environment: "production", send: async () => { throw new Error("x"); } })) === "failed");
  check("the dashboard link needs an origin", dashboardUrl({} as NodeJS.ProcessEnv) === null && buildApprovalEmail(null).text.includes("Sign in to FanFunnel"));
  check("the link is escaped in the HTML", buildApprovalEmail('https://x.example/"><script>').html.includes("&quot;&gt;&lt;script&gt;"));

  // --- the bell -----------------------------------------------------------------
  const { buildNotificationFeed } = await import("@/lib/data/notificationFeed");
  const feed = buildNotificationFeed(
    { pendingWins: [], unreadMessages: [], lowStock: [], outOfSpins: [], approvals: [{ id: "n1", at: "2026-10-31T10:00:00Z" }] },
    null,
    { newSpin: false, lowBalance: false, messages: false },
  );
  check("the bell shows the approval even with every alert toggle off", feed.items.length === 1 && feed.items[0].kind === "approved" && feed.items[0].unread);
  check("…and takes the creator to set up a game", feed.items[0].target.section === "editor" && /approved/i.test(feed.items[0].title));
  const root = join(import.meta.dirname, "../../..");
  const notifications = readFileSync(join(root, "src/lib/data/notifications.ts"), "utf8");
  check("the feed reads both notice kinds for the signed-in account only", /\.in\("kind", \["fan_deleted_data", "creator_approved"\]\)/.test(notifications) && /\.eq\("creator_id", uid\)/.test(notifications));
  const sql = readFileSync(join(root, "supabase/migrations/0066_seat_scopes_approval_notice.sql"), "utf8");
  check("0066 allows the creator_approved notice kind", /check \(kind in \('fan_deleted_data', 'creator_approved'\)\)/.test(sql));

  console.warn = warn;
  console.error = error;
  console.log(`approvalNotice.test: ${passed} checks passed`);
}

main().catch((err) => {
  realError(err);
  process.exit(1);
});
