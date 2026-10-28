import assert from "node:assert/strict";
import { mock } from "node:test";
import { creatorRequestResolved, type CreatorRequestKind, type CreatorRequestStatus } from "@/lib/creatorRequests";
const OWNER = "a0000000-0000-4000-8000-000000000001", OTHER = "b0000000-0000-4000-8000-000000000002";
type Entry = { creator: string; actor: string; kind: CreatorRequestKind; status: CreatorRequestStatus };
const journal = new Map<string, Entry>();
const actorFences = new Map<string, CreatorRequestKind>();
const fenceKey = (actor: string, id: string) => `${actor}:${id}`;
function delayedCreate(creator: string, actor: string, id: string, kind: CreatorRequestKind) {
  if (actorFences.has(fenceKey(actor, id))) return "cancelled";
  journal.set(id, { creator, actor, kind, status: "committed" });
  return "committed";
}
let configured = true, signedIn = true, permitted = true, limited = false, metadataError = false, rpcError = false, malformed = false;
let services = 0, mutations = 0;
const rpcArgs: Record<string, unknown>[] = [], reads: { columns: string; equals: Record<string, unknown> }[] = [];
function metadataQuery(table: string) {
        assert.equal(table, "creator_request_journal");
        const statement = { columns: "", equals: {} as Record<string, unknown> };
        const query = { select: (columns: string) => { statement.columns = columns; return query; }, eq: (name: string, value: unknown) => { statement.equals[name] = value; return query; }, maybeSingle: async () => {
          reads.push(statement);
          assert.equal(statement.columns, "creator_id", "no hashes, references or private receipt data may be selected");
          assert.equal(statement.equals.actor_id, OWNER, "metadata inference is pinned to the authenticated original actor");
          const found = journal.get(String(statement.equals.id));
          return { data: found?.actor === OWNER ? { creator_id: found.creator } : null, error: metadataError ? { message: "PRIVATE metadata failure" } : null };
        } };
        return query;

}
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => configured,
  createClient: async () => ({ from: metadataQuery, auth: { getUser: async () => ({ data: { user: signedIn ? { id: OWNER, user_metadata: { role: "admin" } } : null }, error: null }) }, rpc: async (name: string, args: Record<string, unknown>) => { assert.equal(name, "can_act_for"); assert.equal(args.perm, "grant"); return { data: permitted, error: null }; } }),
  createServiceClient: () => {
    services++;
    return {
      from: () => { throw new Error("metadata must use session RLS, never the service key"); },
      rpc: async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, "reconcile_creator_request"); rpcArgs.push(args);
        if (rpcError) throw new Error("PRIVATE connection failure");
        const id = String(args.p_request), creator = args.p_creator === null ? null : String(args.p_creator), actor = String(args.p_actor), kind = args.p_kind as CreatorRequestKind;
        const found = journal.get(id);
        let status: CreatorRequestStatus;
        // An accepted entry of this same actor wins across target scopes. A
        // missing/wrong target can never certify cancellation after a commit.
        if (found && found.actor === actor && found.kind === kind && found.status === "committed") status = "committed";
        else if (actorFences.has(fenceKey(actor, id))) status = actorFences.get(fenceKey(actor, id)) === kind ? "cancelled" : "conflict";
        else if (found && found.actor === actor && found.kind !== kind) status = "conflict";
        else if (found && (args.p_authorized && found.creator === creator || found.actor === actor || found.creator === actor)) {
          status = found.status;
          if (args.p_cancel && status === "pending") { found.status = "cancelled"; actorFences.set(fenceKey(actor, id), kind); status = "cancelled"; mutations++; }
        } else if (args.p_cancel) {
          actorFences.set(fenceKey(actor, id), kind); status = "cancelled"; mutations++;
        } else if (!found) status = "absent";
        else status = "unavailable";
        return { data: { requestId: malformed ? crypto.randomUUID() : id, kind, status, authorized: args.p_authorized, receipt: { token: "PRIVATE TOKEN", fanName: "PRIVATE FAN", nextServerSeed: "PRIVATE NEXT SEED" }, request_hash: "PRIVATE HASH" }, error: null };
      },
    };
  },
} });
mock.module("@/lib/data/mock", { namedExports: { mockReconcileCreatorRequest: async (id: string, kind: CreatorRequestKind, cancel: boolean) => ({ requestId: id, kind, status: cancel ? "cancelled" : "absent" }) } });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => limited ? Response.json({ error: "rate_limited" }, { status: 429 }) : null } });
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string, kind = "pass", creatorId?: string) => new Request(`http://localhost/api/creator-requests/${id}?${new URLSearchParams({ kind, ...(creatorId ? { creatorId } : {}) })}`);
const post = (id: string, body: unknown) => new Request(`http://localhost/api/creator-requests/${id}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
async function main() {
  const { GET, POST } = await import("./route");
  const absent = crypto.randomUUID();
  signedIn = false;
  check("signed-out reconciliation cannot create a service client", (await GET(get(absent), context(absent))).status === 401 && services === 0);
  signedIn = true;
  check("invalid IDs and kinds never reach privileged code", (await GET(get("bad"), context("bad"))).status === 400 && (await GET(get(absent, "admin"), context(absent))).status === 400 && services === 0);
  limited = true;
  check("status and cancellation checks remain rate limited", (await POST(post(absent, { kind: "pass" }), context(absent))).status === 429 && services === 0);
  limited = false;
  let response = await GET(get(absent), context(absent));
  let result = await response.json();
  check("absence is explicitly nonterminal and cannot release a retry receipt", result.status === "absent" && !creatorRequestResolved(result.status));
  check("reconciliation responses never reveal hashes, fan details, seeds or tokens", Object.keys(result).sort().join() === "authorized,kind,requestId,status" && !JSON.stringify(result).includes("PRIVATE"));
  response = await POST(post(absent, { kind: "pass" }), context(absent)); result = await response.json();
  check("cancelling an absent own-account key produces a durable terminal fence", result.status === "cancelled" && result.requestId === absent && result.kind === "pass" && actorFences.get(fenceKey(OWNER, absent)) === "pass");
  check("unknown context never becomes an assumed own-account operation", rpcArgs.at(-1)?.p_actor === OWNER && rpcArgs.at(-1)?.p_creator === null && rpcArgs.at(-1)?.p_authorized === false && rpcArgs.at(-1)?.p_cancel === true);
  const committed = crypto.randomUUID(); journal.set(committed, { creator: OWNER, actor: OWNER, kind: "pass", status: "committed" });
  const beforeCancelCommit = mutations;
  result = await (await POST(post(committed, { kind: "pass" }), context(committed))).json();
  check("a committed request cannot be cancelled or rewritten", result.status === "committed" && journal.get(committed)?.status === "committed" && mutations === beforeCancelCommit);
  const agency = crypto.randomUUID(); journal.set(agency, { creator: OTHER, actor: OWNER, kind: "focus", status: "committed" });
  permitted = false;
  result = await (await GET(get(agency, "focus"), context(agency))).json();
  check("a revoked original agency actor can learn a bare committed outcome", result.status === "committed" && result.authorized === false && rpcArgs.at(-1)?.p_creator === OTHER && !JSON.stringify(result).includes("PRIVATE"));
  const wrongTarget = await (await POST(post(agency, { kind: "focus", creatorId: OWNER }), context(agency))).json();
  check("wrong target hints cannot cancel an already committed agency operation", wrongTarget.status === "committed" && !actorFences.has(fenceKey(OWNER, agency)));
  const unknownForeign = crypto.randomUUID();
  result = await (await POST(post(unknownForeign, { kind: "import", creatorId: OTHER }), context(unknownForeign))).json();
  check("an absent agency operation is fenced by authenticated actor without a foreign journal row", result.status === "cancelled" && !journal.has(unknownForeign) && actorFences.has(fenceKey(OWNER, unknownForeign)));
  check("the cancelled actor's delayed foreign-target write cannot land", delayedCreate(OTHER, OWNER, unknownForeign, "import") === "cancelled" && !journal.has(unknownForeign));
  check("another actor can independently use the same UUID", delayedCreate(OTHER, OTHER, unknownForeign, "import") === "committed" && journal.get(unknownForeign)?.actor === OTHER);
  const fencedAgain = await (await GET(get(unknownForeign, "import"), context(unknownForeign))).json();
  check("the original actor's bare cancellation survives another actor's matching UUID", fencedAgain.status === "cancelled" && !JSON.stringify(fencedAgain).includes("PRIVATE"));
  const foreign = crypto.randomUUID(); journal.set(foreign, { creator: OTHER, actor: OTHER, kind: "grant", status: "committed" });
  result = await (await GET(get(foreign, "grant", OTHER), context(foreign))).json();
  check("forged metadata cannot expose another actor's private request", result.status === "unavailable" && !JSON.stringify(result).includes("PRIVATE"));
  const foreignCancel = await (await POST(post(foreign, { kind: "grant", creatorId: OTHER }), context(foreign))).json();
  check("withdrawing this actor's nonce never cancels another actor's committed request", foreignCancel.status === "cancelled" && journal.get(foreign)?.status === "committed" && journal.get(foreign)?.actor === OTHER && actorFences.has(fenceKey(OWNER, foreign)));
  const ownUnapproved = crypto.randomUUID();
  result = await (await POST(post(ownUnapproved, { kind: "import" }), context(ownUnapproved))).json();
  check("an account owner can safely fence an absent own key after approval changes", result.status === "cancelled" && actorFences.has(fenceKey(OWNER, ownUnapproved)) && rpcArgs.at(-1)?.p_authorized === false);
  const pending = crypto.randomUUID(); journal.set(pending, { creator: OTHER, actor: OWNER, kind: "focus", status: "pending" });
  result = await (await POST(post(pending, { kind: "focus" }), context(pending))).json();
  check("the original actor can cancel their recorded pending request after permission loss", result.status === "cancelled" && journal.get(pending)?.status === "cancelled");
  result = await (await GET(get(committed, "import"), context(committed))).json();
  check("a wrong operation kind is a nonterminal conflict", result.status === "conflict" && result.kind === "import" && !creatorRequestResolved(result.status));
  permitted = true; malformed = true;
  check("a mismatched service receipt cannot release a different operation", (await GET(get(committed), context(committed))).status === 503);
  malformed = false; metadataError = true;
  check("failed actor metadata lookup is pending rather than assumed absence", (await GET(get(committed), context(committed))).status === 503);
  metadataError = false; rpcError = true;
  response = await POST(post(committed, { kind: "pass" }), context(committed));
  check("transport failures preserve unknown state and hide diagnostics", response.status === 503 && !JSON.stringify(await response.json()).includes("PRIVATE"));
  rpcError = false;
  for (const status of ["rejected", "gone"] as const) {
    const id = crypto.randomUUID(); journal.set(id, { creator: OWNER, actor: OWNER, kind: "import", status });
    result = await (await GET(get(id, "import"), context(id))).json();
    check("rejected and erased outcomes are explicit terminal proofs", result.status === status && creatorRequestResolved(result.status));
  }
  check("all inferred targets came only from original-actor-scoped metadata", reads.length > 5 && reads.every(read => read.columns === "creator_id" && read.equals.actor_id === OWNER));
  const edit = crypto.randomUUID(); journal.set(edit, { creator: OWNER, actor: OWNER, kind: "edit", status: "committed" });
  const editOutcome = await (await GET(get(edit, "edit"), context(edit))).json();
  check("durable edits use the same exact-identity reconciliation contract", editOutcome.status === "committed" && editOutcome.kind === "edit");
  configured = false;
  const demo = await POST(post(crypto.randomUUID(), { kind: "import" }), context(crypto.randomUUID()));
  check("demo reconciliation has the same stripped identity/state contract", demo.status === 200 && (await demo.json()).status === "cancelled");
  console.log(`creator request reconciliation route: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
