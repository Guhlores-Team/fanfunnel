// Scoped TEST/e2e fixture helper. Uses an actual authenticated Auth session;
// never manufactures an assurance claim or prints/stores the capability.
export async function fixtureActorContext(client,creator,permission) {
 const {data,error}=await client.rpc('issue_creator_actor_context',{p_creator:creator,p_permission:permission});
 if(error||typeof data!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(data))throw Error('Authenticated fixture actor context unavailable');
 return data;
}
export async function fixtureCreatorRpc(service,client,name,args) {
 const actor=await client.auth.getUser();
 if(actor.error||!actor.data?.user?.id||(args.p_actor&&args.p_actor!==actor.data.user.id))throw Error('Fixture actor must match authenticated session');
 const scope=name==='save_game_wheel'?'edit_wheel':name==='reconcile_creator_request'?'reconcile':'grant';
 const context=await fixtureActorContext(client,args.p_creator??null,scope);
 return service.rpc(name,{...args,p_actor:actor.data.user.id,p_context:context});
}
