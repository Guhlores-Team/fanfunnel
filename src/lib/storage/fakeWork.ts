import { createHash, randomUUID } from "node:crypto";
import { FakeTables, type Row } from "@/lib/privacy/fakeTables";

/** Protocol fixture; real SQL/RLS/atomicity is tested separately in local PG. */
export class FakeStorageWork {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  failure: ((name: string, args: Record<string, unknown>) => { code?: string; message: string } | Error | null) | null = null;
  constructor(readonly tables: FakeTables, readonly options: {
    active?: (owner: string) => boolean;
    admin?: (actor: string) => boolean;
    authExists?: (owner: string) => boolean;
    reserve?: () => string;
    onAudit?: (entry: Record<string, unknown>) => void;
    insertMedia?: (row: Row) => boolean;
    removeMedia?: (id: string, owner: string, path: string) => boolean;
  } = {}) {}
  private active(owner: string) {
    const profile = this.tables.rows("profiles").find((row) => row.id === owner);
    return (this.options.active?.(owner) ?? (!!profile && profile.is_active !== false && (profile.approval_status === undefined || profile.approval_status === "approved" || profile.role === "admin"))) &&
      !this.tables.rows("creator_storage_deletions").some((row) => row.owner_id === owner && !["paused", "complete"].includes(String(row.state)));
  }
  private insertAudit(id: string, actor: unknown, action: unknown, target: unknown, details: Record<string, unknown>) {
    if (this.tables.rows("admin_audit_log").some((row) => row.id === id)) return;
    this.tables.rows("admin_audit_log").push({ id, actor_id: actor, action, target_type: "profile", target_id: target, details });
    this.options.onAudit?.({ actorId: actor, action, targetType: "profile", targetId: target, details });
  }
  rpc = async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message: string } | null }> => {
    this.calls.push({ name, args });
    const failure = this.failure?.(name, args);
    if (failure instanceof Error) throw failure;
    if (failure) return { data: null, error: failure };
    const now = new Date().toISOString();
    const objects = this.tables.rows("creator_storage_objects");
    const owner = String(args.p_owner ?? "");
    const object = objects.find((row) => row.id === args.p_id);
    const okay = (data: unknown) => ({ data, error: null });
    const manifest = (record: Row, attempt: unknown, worker: unknown = null) => {
      const entries=this.tables.rows("creator_storage_dispatches");
      if (!entries.some((row)=>row.kind==="manifest" && row.attempt_id===attempt && row.object_id===record.id)) entries.push({id:randomUUID(),owner_id:record.owner_id,attempt_id:attempt,worker_id:worker,kind:"manifest",object_id:record.id,bucket:record.bucket,path:record.path,state:"acknowledged",created_at:now,settled_at:now});
    };
    const denied = () => ({ data: null, error: { code: "42501", message: "refused" } });
    if (name === "creator_storage_register_upload") {
      if (!this.active(owner) || !String(args.p_path).startsWith(`${owner}/`) || objects.some((row) => row.id === args.p_id || row.path === args.p_path)) return denied();
      objects.push({ id: args.p_id, owner_id: owner, bucket: args.p_bucket, path: args.p_path, upload_state: "inflight", cleanup_kind: "none", media_id: null, audit_actor: null, created_at: now, updated_at: now, expires_at: new Date(Date.now() + 120000).toISOString(), published_at: null, removed_at: null, attempts: 0, next_attempt_at: now, last_attempt_at: null, deletion_attempt: null, upload_registered:true });
      return okay({ id: args.p_id, registered: true });
    }
    if (name === "creator_storage_finish_upload") {
      if (!object) return denied();
      const eligible = this.active(String(object.owner_id)) && Date.parse(String(object.expires_at)) > Date.now();
      if (["inflight", "uncertain"].includes(String(object.upload_state)) && ["stored", "rejected", "uncertain"].includes(String(args.p_outcome))) object.upload_state = args.p_outcome;
      if (object.cleanup_kind === "none" && (!eligible || ["rejected", "uncertain", "cleanup"].includes(String(args.p_outcome)))) object.cleanup_kind = "orphan";
      if (args.p_outcome === "cleanup") object.media_id ??= this.tables.rows("creator_media").find((row) => row.creator_id === object.owner_id && row.path === object.path)?.id ?? null;
      const publish = eligible && object.upload_state === "stored" && object.cleanup_kind === "none" && !object.removed_at;
      if (args.p_outcome === "publish" && publish) object.published_at = now;
      object.updated_at = now;
      return okay(publish);
    }
    if (name === "creator_storage_queue_remove") {
      const rows = args.p_objects as { id: string; path: string }[];
      if (args.p_admin ? !(this.options.admin?.(String(args.p_actor)) ?? false) : args.p_actor !== owner || !this.active(owner)) return denied();
      if (!rows.every((row) => row.path.startsWith(`${owner}/`) && this.tables.rows("creator_media").some((m) => m.id === row.id && m.creator_id === owner && m.path === row.path))) return denied();
      for (const row of rows) {
        let record = objects.find((entry) => entry.path === row.path && entry.bucket === "creator-media");
        if (!record) {
          record = { id: randomUUID(), owner_id: owner, bucket: "creator-media", path: row.path, removed_at: null, published_at: now, created_at: now, expires_at: now, attempts: 0 };
          objects.push(record);
        }
        Object.assign(record, { upload_state: "stored", cleanup_kind: "media", media_id: row.id, removed_at: null, updated_at: now, audit_actor: args.p_admin ? args.p_actor : null });
      }
      return okay(rows.length);
    }
    if (name === "creator_storage_complete_remove") {
      if (!object || object.cleanup_kind === "none" || ["inflight", "uncertain"].includes(String(object.upload_state))) return okay(false);
      if (object.removed_at) return okay(true);
      if (object.media_id) {
        if (this.options.removeMedia && !this.options.removeMedia(String(object.media_id), String(object.owner_id), String(object.path))) return { data: null, error: { code: "XX000", message: "delete failed" } };
        if (!this.options.removeMedia) {
          const media = this.tables.rows("creator_media");
          const index = media.findIndex((row) => row.id === object.media_id && row.creator_id === object.owner_id && row.path === object.path);
          if (index >= 0) media.splice(index, 1);
        }
      }
      object.removed_at = now;
      object.updated_at = now;
      if (object.audit_actor) this.insertAudit(String(object.id), object.audit_actor, "account.media_remove", object.owner_id, { photosRemoved: 1 });
      return okay(true);
    }
    if (name === "creator_storage_publish_media") {
      if (!object) return denied();
      const media = this.tables.rows("creator_media");
      const existing = media.find((row) => row.id === object.id && row.path === object.path && row.creator_id === object.owner_id);
      if (existing && object.media_id === object.id && object.cleanup_kind === "none" && !object.removed_at) return okay(existing);
      if (!this.active(String(object.owner_id)) || object.upload_state !== "stored" || object.cleanup_kind !== "none" || object.removed_at) return denied();
      const row = { id: object.id, creator_id: object.owner_id, path: object.path, caption: args.p_caption, width: args.p_width, height: args.p_height, sort_order: args.p_sort_order ?? 0, sfw_attested_at: now, created_at: now };
      if (this.options.insertMedia && !this.options.insertMedia(row)) return { data: null, error: { code: "XX000", message: "insert failed" } };
      media.push(row); object.media_id = object.id; object.published_at = now;
      return okay(row);
    }
    if (name === "creator_storage_work_claim") {
      const rows = objects.filter((row) => !row.removed_at && row.cleanup_kind !== "account" && Date.parse(String(row.next_attempt_at ?? row.created_at ?? now)) <= Date.now() &&
        (row.cleanup_kind !== "none" || (!row.published_at && Date.parse(String(row.expires_at)) < Date.now())))
        .sort((a,b) => String(a.next_attempt_at ?? a.created_at).localeCompare(String(b.next_attempt_at ?? b.created_at)))
        .slice(0, Math.min(Number(args.p_limit) || 20,20));
      for (const row of rows) { const attempts=Number(row.attempts)||0; row.attempts=attempts+1; row.last_attempt_at=now; row.next_attempt_at=new Date(Date.now()+Math.min(900000,5000*2**Math.min(attempts,8))).toISOString(); row.updated_at=now; }
      return okay(rows);
    }
    if (name === "creator_storage_manifest") {
      const job = this.tables.rows("creator_storage_deletions").find((row) => row.owner_id === owner);
      if (!job || job.attempt_id !== args.p_attempt || job.lease_id !== args.p_worker || Date.parse(String(job.lease_until)) <= Date.now() || !["pending","auth_deleting"].includes(String(job.state))) return okay(null);
      const paths = args.p_paths as string[];
      if (!Array.isArray(paths) || paths.length>100 || !paths.every((path) => path.startsWith(`${owner}/`) && !path.includes("/../"))) return denied();
      for (const path of paths) {
        let record=objects.find((row) => row.bucket===args.p_bucket && row.path===path);
        if (!record) { record={ id:randomUUID(),owner_id:owner,bucket:args.p_bucket,path,media_id:this.tables.rows("creator_media").find((row)=>row.creator_id===owner && row.path===path)?.id??null,created_at:now,expires_at:now,published_at:null,attempts:0,next_attempt_at:now }; objects.push(record); }
        Object.assign(record,{upload_state:"stored",cleanup_kind:"account",deletion_attempt:args.p_attempt,removed_at:null,updated_at:now}); manifest(record,args.p_attempt,args.p_worker);
      }
      return okay(paths.length);
    }
    if (name === "creator_storage_dispatch") {
      const calls=this.tables.rows("creator_storage_dispatches");
      if (args.p_operation === "begin") {
        if (calls.some((row)=>row.id===args.p_id)) return okay({dispatch:false});
        const job=this.tables.rows("creator_storage_deletions").find((row)=>row.owner_id===owner);
        if (args.p_attempt) {
          if (!job || job.attempt_id!==args.p_attempt || job.lease_id!==args.p_worker || Date.parse(String(job.lease_until))<=Date.now() || !["pending","auth_deleting"].includes(String(job.state))) return okay(null);
        }
        const target=objects.find((row)=>row.id===args.p_object && row.owner_id===owner);
        if (args.p_kind === "remove" && (!target || target.removed_at || target.cleanup_kind==="none" || ["inflight","uncertain"].includes(String(target.upload_state)) || (args.p_attempt && target.deletion_attempt!==args.p_attempt))) return okay(null);
        if (args.p_attempt && args.p_kind === "remove" && !calls.some((row)=>row.kind==="manifest" && row.attempt_id===args.p_attempt && row.object_id===target?.id && row.path===target?.path)) return okay(null);
        if (!args.p_attempt && args.p_kind === "remove" && (target?.cleanup_kind === "account" || (job && !["paused","complete"].includes(String(job.state)))) && !(args.p_origin_upload && target?.upload_registered && !target.published_at)) return okay(null);
        if (args.p_kind === "auth" && (!args.p_attempt || job?.state!=="auth_deleting")) return okay(null);
        calls.push({id:args.p_id,owner_id:owner,attempt_id:args.p_attempt,worker_id:args.p_worker,kind:args.p_kind,object_id:target?.id??null,bucket:target?.bucket??null,path:target?.path??null,state:"pending",created_at:now,settled_at:null});
        return okay({dispatch:true});
      }
      const call=calls.find((row)=>row.id===args.p_id && row.owner_id===owner);
      if (!call) return okay(null);
      if (["acknowledged","rejected"].includes(String(call.state))) return okay({state:call.state});
      if (args.p_outcome==="acknowledged" && call.kind==="remove") {
        const done=await this.rpc("creator_storage_complete_remove",{p_id:call.object_id});
        if (done.error || done.data!==true) return {data:null,error:{code:"40001",message:"completion failed"}};
      }
      call.state=args.p_outcome; call.settled_at=args.p_outcome==="uncertain"?null:now;
      return okay({state:call.state});
    }
    if (name === "creator_storage_account") {
      const jobs = this.tables.rows("creator_storage_deletions");
      let job = jobs.find((row) => row.owner_id === owner);
      const profile = this.tables.rows("profiles").find((row) => row.id === owner);
      const out = () => job ? { id: job.id, state: job.state, attempt_id: job.attempt_id, links: (job.link_hashes as unknown[]).length } : null;
      if (args.p_operation === "begin") {
        if (job && job.state !== "paused") return okay(out());
        const reserved = this.options.reserve?.() ?? "ok";
        if (reserved !== "ok") return okay({ error: reserved });
        if (!profile) return okay({ error: "not_found" });
        const hashes = this.tables.rows("fan_passes").filter((row) => row.creator_id === owner).map((row) => createHash("sha256").update(String(row.token)).digest("hex"));
        if (!job) {
          job = { owner_id: owner, id: randomUUID(), created_at: now };
          jobs.push(job);
        }
        Object.assign(job, { state: "pending", attempt_id: randomUUID(), was_role: profile.role, was_active: profile.is_active !== false, actor_id: args.p_actor, action: args.p_action, link_hashes: hashes, updated_at: now, lease_id: null });
        await this.tables.from("profiles").update({ role: profile.role === "admin" ? "creator" : profile.role, is_active: false }).eq("id", owner);
        objects.filter((row) => row.owner_id === owner && !row.removed_at).forEach((row) => { row.cleanup_kind = "account"; row.deletion_attempt=job!.attempt_id; manifest(row,job!.attempt_id); });
        return okay(out());
      }
      if (!job) return okay(null);
      if (job.state === "complete") return okay(out());
      if (args.p_operation === "claim") {
        if (job.state === "paused" || (job.lease_id && job.lease_id !== args.p_worker && Date.parse(String(job.lease_until)) > Date.now())) return okay(null);
        job.lease_id = args.p_worker; job.lease_until = new Date(Date.now() + 180000).toISOString();
        return okay(out());
      }
      if (job.lease_id !== args.p_worker || Date.parse(String(job.lease_until))<=Date.now()) return okay(null);
      if (args.p_operation === "check") { job.lease_until=new Date(Date.now()+180000).toISOString(); return okay(out()); }
      if (args.p_operation === "release") { job.lease_id = null; return okay(out()); }
      if (args.p_operation === "pause") {
        if (!profile || this.tables.rows("creator_storage_dispatches").some((row)=>row.owner_id===owner && ["pending","uncertain"].includes(String(row.state)))) return okay(null);
        await this.tables.from("profiles").update({ role: job.was_role, is_active: job.was_active }).eq("id", owner);
        job.state = "paused"; job.lease_id = null; return okay(out());
      }
      if (args.p_operation === "prepare") {
        if (objects.some((row) => row.owner_id === owner && !row.removed_at)) return okay({ state: "pending" });
        job.state = "auth_deleting"; return okay(out());
      }
      if (args.p_operation === "auth_deleted") {
        if (this.options.authExists?.(owner) ?? !!profile) return okay(null);
        this.tables.rows("creator_storage_dispatches").filter((row)=>row.owner_id===owner && row.kind==="auth" && ["pending","uncertain"].includes(String(row.state))).forEach((row)=>{row.state="acknowledged";row.settled_at=now;});
        job.state = "auth_deleted"; return okay(out());
      }
      if (args.p_operation === "complete") {
        if (job.state !== "auth_deleted") return okay(null);
        for (const hash of job.link_hashes as string[]) if (!this.tables.rows("link_tombstones").some((row) => row.token_hash === hash)) this.tables.rows("link_tombstones").push({ token_hash: hash, reason: "creator_closed" });
        this.insertAudit(String(job.id), job.actor_id, job.action, owner, { role: job.was_role, fanLinks: (job.link_hashes as unknown[]).length });
        job.state = "complete"; job.completed_at = now; job.lease_id = null; return okay(out());
      }
      return denied();
    }
    if (name === "creator_storage_prune") return okay(0);
    return denied();
  };
  from = (table: string) => {
    if (!table.startsWith("creator_storage_")) return this.tables.from(table);
    const filters: ((row: Row) => boolean)[] = [];
    let limit = Infinity, single = false, update: Row | null = null, sort: string | null = null;
    const result = () => {
      let rows = this.tables.rows(table).filter((row) => filters.every((filter) => filter(row)));
      if (sort) rows = rows.sort((a, b) => String(a[sort!]).localeCompare(String(b[sort!])));
      rows = rows.slice(0, limit);
      if (update) rows.forEach((row) => Object.assign(row, update));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const query: Record<string, unknown> = {
      select: () => query,
      eq: (key: string, value: unknown) => (filters.push((row) => row[key] === value), query),
      neq: (key: string, value: unknown) => (filters.push((row) => row[key] !== value), query),
      in: (key: string, values: unknown[]) => (filters.push((row) => values.includes(row[key])), query),
      is: (key: string, value: unknown) => (filters.push((row) => row[key] === value), query),
      lt: (key: string, value: unknown) => (filters.push((row) => String(row[key]) < String(value)), query),
      order: (key: string) => ((sort = key), query),
      limit: (n: number) => ((limit = n), query),
      maybeSingle: () => { single = true; return Promise.resolve(result()); },
      update: (values: Row) => ((update = values), query),
      then: (resolve: (value: unknown) => void) => resolve(result()),
    };
    return query;
  };
}
