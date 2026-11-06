// Local disposable PG only: cover the hosted extension layout and legacy public.
export function probeCryptoNamespace(db, psql, expectedSchema) {
  const failures = [];
  const run = query => psql(db, ["-c", query], { allowFail: true });
  const metadata = run(`select jsonb_build_object(
    'namespace',(select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto'),
    'functions',(select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc ~ '(digest|gen_random_bytes)\\('),
    'safe',(select bool_and(p.prosecdef and p.proconfig=array['search_path=public, extensions, pg_temp']) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc ~ '(digest|gen_random_bytes)\\('),
    'sha',encode(pg_catalog.sha256(pg_catalog.convert_to('abc','UTF8')),'hex'));`);
  let observed;
  try { observed = JSON.parse(metadata.stdout.trim()); } catch { failures.push("crypto namespace metadata unavailable"); }
  if (observed && (observed.namespace !== expectedSchema || observed.functions < 15 || observed.safe !== true
    || observed.sha !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")) failures.push("crypto namespace/config/hash contract mismatch");
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const schema of ["public", "extensions"]) {
      const denied = run(`begin; set local role ${role}; create function ${schema}.crypto_shadow_probe(text,text) returns text language sql as 'select ''denied''::text'; rollback;`);
      if (denied.status === 0 || !/permission denied for schema/.test(denied.stderr)) failures.push(`${role} can CREATE in ${schema}`);
    }
  }
  if (!failures.length) console.log(`PASS ${db}: pgcrypto ${expectedSchema}, ${observed.functions} direct-crypto functions pinned to trusted namespaces; 6 actual API-role schema CREATE refusals`);
  return failures;
}
