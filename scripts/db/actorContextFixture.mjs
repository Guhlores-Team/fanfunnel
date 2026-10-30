// Disposable PostgreSQL fixture only: authenticates a real stub Auth session,
// mints via the authenticated RPC, then enters the actual service-only gateway.
import {randomUUID} from 'node:crypto';
export const sqlQuote=s=>`'${String(s).replaceAll("'","''")}'`;
export async function mintActorContext(sql,actor,creator,scope='grant',aal='aal1',sessionId=randomUUID()) {
 const q=sqlQuote,claims=JSON.stringify({sub:actor,role:'authenticated',session_id:sessionId,aal,exp:Math.floor(Date.now()/1000)+3600});
 await sql(`insert into auth.sessions(id,user_id) values(${q(sessionId)},${q(actor)}) on conflict(id) do nothing;`);
 const text=await sql(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claim.sub',${q(actor)},true);perform set_config('request.jwt.claims',${q(claims)},true);end$$;select public.issue_creator_actor_context(${creator===null?'null':q(creator)},${q(scope)});commit;`);
 const context=text.trim().split('\n').at(-1);
 if(!/^[a-f0-9-]{36}$/.test(context))throw Error('actor fixture context missing');
 return {context,sessionId};
}
export const CREATOR_GATEWAYS=new Set(['grant_pass_spins','grant_focus_pack','create_pass_grant','import_fans_durable','edit_pass_grant','cancel_fan_focus','reconcile_creator_request','save_game_wheel']);
// Positional contracts in retained0059/61 probes. These arrays are untouched
// economic intents; the new first argument adds independently minted authority.
export async function withActorContext(sql,name,args,run) {
 if(!CREATOR_GATEWAYS.has(name))return run(args);
 const at={grant_pass_spins:8,grant_focus_pack:6,create_pass_grant:12,import_fans_durable:4,edit_pass_grant:4,cancel_fan_focus:3,reconcile_creator_request:2,save_game_wheel:4};
 if(name==='cancel_fan_focus'&&args.length===3)args=[...args,args[0]];
 const creator=name==='reconcile_creator_request'?args[1]:name==='cancel_fan_focus'?args[0]:args[1];
 const actor=args[at[name]]??creator;
 const full={grant_pass_spins:9,grant_focus_pack:7,create_pass_grant:13,import_fans_durable:5,reconcile_creator_request:6};
 if(full[name]){args=[...args];while(args.length<full[name])args.push(args.length===at[name]?actor:name==='create_pass_grant'&&args.length===11?'1':name==='reconcile_creator_request'?'false':'null');}
 const unquote=s=>s==='null'?null:s.replace(/^'|'$/g,'').replaceAll("''", "'");
 const {context}=await mintActorContext(sql,unquote(actor),unquote(creator),name==='save_game_wheel'?'edit_wheel':name==='reconcile_creator_request'?'reconcile':'grant');
 try{return await run([sqlQuote(context),...args]);}
 finally{await sql(`delete from public.creator_actor_contexts where id=${sqlQuote(context)};`);}
}
