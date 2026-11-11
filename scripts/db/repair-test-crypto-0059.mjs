// One-time TEST-only correction for the already-applied, unreleased0059.
// Retire its workflow invocation with0060; retain this helper and its tests.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SPEC_RAW = readFileSync(new URL("./crypto-namespace-0059-manifest.json", import.meta.url));
const SPEC = JSON.parse(SPEC_RAW.toString("utf8"));
export const MANIFEST_SHA256 = "72e4599213e1705712af5c1865877b0a33b1667053412866f5c30b3affb6a2f7";
export const TEST_REF = "snmcrmhgevfqggxdiomu";
export const MANAGEMENT_URL = `https://api.supabase.com/v1/projects/${TEST_REF}/database/query`;
export const SOURCE_SHA256 = "c91468813552d75acdf783dfb0f17b73377afc9e9dc6c66dbcde28c69b7fe2e4";
export const REQUEST_TIMEOUT_MS = 20_000;
const TARGET_CONFIG = "search_path=public, extensions, pg_temp";
const refuse = () => { throw new Error("CRYPTO_REPAIR_REFUSED"); };

export function repairPreflight(env, root = ROOT) {
  if (createHash("sha256").update(SPEC_RAW).digest("hex") !== MANIFEST_SHA256) refuse();
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "pull_request"
    || env.GITHUB_REPOSITORY !== "Guhlores-Team/fanfunnel" || env.GITHUB_HEAD_REF !== "dashboard-redesign"
    || env.SUPABASE_TEST_PROJECT_REF !== TEST_REF) refuse();
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (typeof token !== "string" || token.length < 12 || token.length > 4096 || /\s/.test(token)) refuse();
  const migrations = readdirSync(resolve(root, "supabase/migrations")).filter(name => name.endsWith(".sql"));
  if (migrations.some(name => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) refuse();
  if (migrations.map(name => name.slice(0, 4)).sort().at(-1) !== "0059") refuse();
  const source = readFileSync(resolve(root, "supabase/migrations/0059_focus_attempt_ledger.sql"));
  if (createHash("sha256").update(source).digest("hex") !== SOURCE_SHA256) refuse();
  return { token };
}

export function correctionSQL(readOnly = false) {
  if (createHash("sha256").update(SPEC_RAW).digest("hex") !== MANIFEST_SHA256) refuse();
  if (SPEC.functions.length !== 15 || new Set(SPEC.functions.map(row => row.signature)).size !== 15) refuse();
  for (const row of SPEC.functions) {
    if (!/^public\.[a-z_]+\((?:uuid|text|integer|jsonb|,| )*\)$/.test(row.signature)
      || !/^[a-f0-9]{64}$/.test(row.bodySha256) || row.language !== "plpgsql" || row.securityDefiner !== true
      || row.owner !== "postgres" || typeof row.serviceExecute !== "boolean" || JSON.stringify(row.oldConfig) !== '["search_path=public"]') refuse();
  }
  if (readOnly) return readbackSQL();
  const manifest = JSON.stringify(SPEC.functions);
  // Only reviewed literals enter this query. Environment/HTTP values never do.
  return `begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
do $repair$
declare expected jsonb := $manifest$${manifest}$manifest$::jsonb;
  item jsonb; f pg_catalog.pg_proc%rowtype; object_oid oid; extension_oid oid; extension_schema text;
  before_rows jsonb := '{}'::jsonb; old_count integer := 0; changed_count integer := 0; role_name text; schema_name text;
begin
  perform pg_catalog.pg_advisory_xact_lock(5931059, 1);
  if (select max(version) from supabase_migrations.schema_migrations) is distinct from '0059' then raise exception 'CRYPTO_REPAIR_HISTORY_REFUSED'; end if;
  select e.oid,n.nspname into extension_oid,extension_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  if extension_schema is null or extension_schema not in ('public','extensions') then raise exception 'CRYPTO_REPAIR_NAMESPACE_REFUSED'; end if;
  foreach schema_name in array array['public','extensions'] loop
    if pg_catalog.to_regnamespace(schema_name) is null then raise exception 'CRYPTO_REPAIR_NAMESPACE_REFUSED'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if pg_catalog.has_schema_privilege(role_name,schema_name,'CREATE') then raise exception 'CRYPTO_REPAIR_NAMESPACE_REFUSED'; end if;
    end loop;
  end loop;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      join pg_catalog.pg_depend d on d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.refclassid='pg_catalog.pg_extension'::regclass and d.refobjid=extension_oid and d.deptype='e'
      where n.nspname=extension_schema and ((p.proname='digest' and pg_catalog.oidvectortypes(p.proargtypes) in ('text, text','bytea, text')) or (p.proname='gen_random_bytes' and pg_catalog.oidvectortypes(p.proargtypes)='integer'))) <> 3 then raise exception 'CRYPTO_REPAIR_PRIMITIVES_REFUSED'; end if;
  if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','extensions') and p.proname in ('digest','gen_random_bytes')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.refclassid='pg_catalog.pg_extension'::regclass and d.refobjid=extension_oid and d.deptype='e')) then raise exception 'CRYPTO_REPAIR_SHADOW_REFUSED'; end if;
  -- Validate ALL15 before the first ALTER; the advisory lock coordinates this correction only.
  for item in select value from jsonb_array_elements(expected) order by value->>'signature' loop
    object_oid := pg_catalog.to_regprocedure(item->>'signature');
    if object_oid is null then raise exception 'CRYPTO_REPAIR_DEFINITION_REFUSED'; end if;
    select * into f from pg_catalog.pg_proc where oid=object_oid;
    if f.pronamespace <> 'public'::regnamespace or pg_catalog.pg_get_userbyid(f.proowner) <> item->>'owner'
      or (select lanname from pg_catalog.pg_language where oid=f.prolang) <> item->>'language'
      or not f.prosecdef or encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc,'UTF8')),'hex') <> item->>'bodySha256'
      or pg_catalog.has_function_privilege('anon',object_oid,'EXECUTE') or pg_catalog.has_function_privilege('authenticated',object_oid,'EXECUTE')
      or pg_catalog.has_function_privilege('service_role',object_oid,'EXECUTE') is distinct from (item->>'serviceExecute')::boolean
      or (f.proconfig is distinct from array['search_path=public'] and f.proconfig is distinct from array['${TARGET_CONFIG}']) then raise exception 'CRYPTO_REPAIR_DEFINITION_REFUSED'; end if;
    before_rows := before_rows || jsonb_build_object(object_oid::text, to_jsonb(f)-'proconfig');
    if f.proconfig = array['search_path=public'] then old_count := old_count+1; end if;
  end loop;
  for item in select value from jsonb_array_elements(expected) order by value->>'signature' loop
    object_oid := pg_catalog.to_regprocedure(item->>'signature');
    if (select proconfig from pg_catalog.pg_proc where oid=object_oid) = array['search_path=public'] then
      execute 'alter function ' || object_oid::regprocedure::text || ' set search_path to public,extensions,pg_temp';
      changed_count := changed_count+1;
    end if;
  end loop;
  for item in select value from jsonb_array_elements(expected) loop
    object_oid := pg_catalog.to_regprocedure(item->>'signature');
    select * into f from pg_catalog.pg_proc where oid=object_oid;
    if (to_jsonb(f)-'proconfig') is distinct from before_rows->object_oid::text then raise exception 'CRYPTO_REPAIR_METADATA_CHANGED'; end if;
    if f.proconfig is distinct from array['${TARGET_CONFIG}'] then raise exception 'CRYPTO_REPAIR_CONFIG_UNVERIFIED'; end if;
  end loop;
end $repair$;
commit;`;
}

export function readbackSQL() {
  return `with expected as (select value item from jsonb_array_elements($manifest$${JSON.stringify(SPEC.functions)}$manifest$::jsonb)),
extension as (select e.oid,n.nspname from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto'),
functions as (select e.item,p.*,l.lanname from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.item->>'signature') left join pg_catalog.pg_language l on l.oid=p.prolang),
primitives as (select p.oid,d.refobjid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
left join pg_catalog.pg_depend d on d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.refclassid='pg_catalog.pg_extension'::regclass and d.deptype='e'
where n.nspname in ('public','extensions') and p.proname in ('digest','gen_random_bytes'))
select jsonb_build_object('namespace',(select nspname from extension),'history',(select max(version) from supabase_migrations.schema_migrations),
'namespaceSafe',(select count(distinct n.oid)=2 and count(*)=6 and bool_and(not pg_catalog.has_schema_privilege(r.role_name,n.oid,'CREATE')) from pg_catalog.pg_namespace n cross join (values('anon'),('authenticated'),('service_role')) r(role_name) where n.nspname in ('public','extensions')),
'primitiveCount',(select count(*) from primitives where refobjid=(select oid from extension)),
'shadowCount',(select count(*) from primitives where refobjid is distinct from (select oid from extension)),
'definitions',(select count(*) from functions f where f.pronamespace='public'::regnamespace and pg_catalog.pg_get_userbyid(f.proowner)=f.item->>'owner' and f.lanname=f.item->>'language' and f.prosecdef
and encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc,'UTF8')),'hex')=f.item->>'bodySha256'
and not pg_catalog.has_function_privilege('anon',f.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',f.oid,'EXECUTE')
and pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE')=(f.item->>'serviceExecute')::boolean),
'oldConfigs',(select count(*) from functions where proconfig=array['search_path=public']),
'targetConfigs',(select count(*) from functions where proconfig=array['${TARGET_CONFIG}'])) as result;`;
}

export async function runCorrection({ env = process.env, root = ROOT, fetchImpl = fetch, readOnly = false } = {}) {
  const { token } = repairPreflight(env, root);
  async function request(isRead) {
    let timeout;
    try {
      const operation = (async () => {
        const response = await fetchImpl(MANAGEMENT_URL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: correctionSQL(isRead), read_only: isRead }) });
        if (response.status !== 201) throw new Error("response");
        if (!isRead) {
          const acknowledgement = await response.json();
          if (!Array.isArray(acknowledgement) || acknowledgement.length !== 0) throw new Error("acknowledgement");
          return null;
        }
        const rows = await response.json();
        const row = Array.isArray(rows) && rows.length === 1 ? rows[0]?.result : null;
        if (!row || !["public", "extensions"].includes(row.namespace) || row.history !== "0059" || row.namespaceSafe !== true
          || row.primitiveCount !== 3 || row.shadowCount !== 0 || row.definitions !== 15
          || !Number.isSafeInteger(row.oldConfigs) || !Number.isSafeInteger(row.targetConfigs)
          || row.oldConfigs < 0 || row.targetConfigs < 0 || row.oldConfigs + row.targetConfigs !== 15) throw new Error("result");
        return { status: "readback", extensionSchema: row.namespace, verifiedFunctions: 15,
          oldConfigFunctions: row.oldConfigs, targetConfigFunctions: row.targetConfigs,
          configurationVerified: row.targetConfigs === 15 };
      })();
      return await Promise.race([operation,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("timeout")), REQUEST_TIMEOUT_MS); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  if (readOnly) {
    try { return await request(true); }
    catch { throw new Error("CRYPTO_REPAIR_READBACK_UNAVAILABLE"); }
  }
  try { await request(false); }
  catch { throw new Error("CRYPTO_REPAIR_OUTCOME_UNKNOWN_USE_READBACK"); }
  try {
    const current = await request(true);
    if (!current?.configurationVerified) throw new Error("result");
    return { ...current, status: "verified", correctionSubmitted: true, definitionAclOwnerPreserved: true };
  } catch { throw new Error("CRYPTO_REPAIR_SUBMITTED_READBACK_UNVERIFIED"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--read-only")) {
    console.error("CRYPTO_REPAIR_REFUSED"); process.exitCode = 1;
  } else {
    runCorrection({ readOnly: args[0] === "--read-only" }).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(["CRYPTO_REPAIR_REFUSED", "CRYPTO_REPAIR_READBACK_UNAVAILABLE", "CRYPTO_REPAIR_OUTCOME_UNKNOWN_USE_READBACK", "CRYPTO_REPAIR_SUBMITTED_READBACK_UNVERIFIED"].includes(error.message) ? error.message : "CRYPTO_REPAIR_REFUSED");
      process.exitCode = 1;
    });
  }
}
