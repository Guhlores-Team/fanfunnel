import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { publicCreatorName } from "@/lib/publicCreator";

// WG-07: who (which agency seat) sent a reply or changed a prize's status on
// a creator's account, for the "via <name>" line in the Inbox and Fulfilment.
// messages.actor_id / redemptions.actor_id (0073) hold the profile id; a
// creator cannot read other profiles under RLS, so the name is read here with
// the service role, under two rules:
//   1. the caller's own session proves, here and every time, that it may act
//      for `creatorId` (literal `true` from can_act_for with the permission
//      the caller is using: 'view' for the creator's own reads, 'chat' for a
//      seat in the Inbox, 'fulfil' for a seat in the queue). Without that
//      proof nothing is read or returned;
//   2. a name is returned only for a profile that owns or holds a seat in the
//      creator's own agency. Anyone else (a removed seat, support) gets the
//      neutral label, and an e-mail address is never used as a name.

export const TEAM_MEMBER = "a team member";
const MAX_ACTORS = 50;
const TTL_MS = 60_000;
const cache = new Map<string, { name: string; until: number }>();

type Rows<T> = PromiseLike<{ data: T[] | null; error: unknown }>;
type One<T> = PromiseLike<{ data: T | null; error: unknown }>;
type Service = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => { maybeSingle: () => One<Record<string, unknown>>; in: (column: string, values: string[]) => Rows<Record<string, unknown>> };
      in: (column: string, values: string[]) => Rows<Record<string, unknown>>;
    };
  };
};

type Session = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export async function actorNames(
  session: unknown,
  creatorId: string,
  perm: "view" | "chat" | "fulfil",
  actorIds: Iterable<string | null | undefined>,
  now: number = Date.now(),
): Promise<Map<string, string>> {
  const ids = [...new Set([...actorIds].filter((id): id is string => typeof id === "string" && id !== "" && id !== creatorId))].slice(0, MAX_ACTORS);
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  // Before the cache and before the service role: no proof, no names.
  try {
    const { data: allowed, error } = await (session as Session).rpc("can_act_for", { target_creator: creatorId, perm });
    if (error || allowed !== true) return out;
  } catch {
    return out;
  }
  const missing: string[] = [];
  for (const id of ids) {
    const hit = cache.get(`${creatorId}:${id}`);
    if (hit && hit.until > now) out.set(id, hit.name);
    else missing.push(id);
  }
  if (missing.length === 0) return out;
  const names = await readNames(creatorId, missing);
  for (const id of missing) {
    const name = names.get(id) ?? TEAM_MEMBER;
    out.set(id, name);
    cache.set(`${creatorId}:${id}`, { name, until: now + TTL_MS });
  }
  return out;
}

async function readNames(creatorId: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const service = createServiceClient() as unknown as Service;
    const { data: creator } = await service.from("profiles").select("org_id").eq("id", creatorId).maybeSingle();
    const orgId = typeof creator?.org_id === "string" ? creator.org_id : null;
    if (!orgId) return names;
    const [{ data: seats }, { data: org }] = await Promise.all([
      service.from("org_members").select("profile_id").eq("org_id", orgId).in("profile_id", ids),
      service.from("orgs").select("owner_id").eq("id", orgId).maybeSingle(),
    ]);
    const team = new Set((seats ?? []).map((row) => String(row.profile_id)));
    if (typeof org?.owner_id === "string" && ids.includes(org.owner_id)) team.add(org.owner_id);
    if (team.size === 0) return names;
    const { data: profiles } = await service.from("profiles").select("id, display_name").in("id", [...team]);
    for (const row of profiles ?? []) {
      const name = publicCreatorName(typeof row.display_name === "string" ? row.display_name : null);
      if (name) names.set(String(row.id), name);
    }
  } catch {
    /* no service key or a failed read: everyone keeps the neutral label */
  }
  return names;
}

/** Test hook: forget every cached name. */
export function resetActorNameCache(): void {
  cache.clear();
}
