import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";
/** Call only after every disclosed value has decrypted and the response is ready.
 * One atomic batch logs a server disclosure request, never a credit/reward award. */
export async function recordRewardDisclosures(sb: ReturnType<typeof createServiceClient>,token:string,spinIds:readonly string[]):Promise<boolean>{
  if(!spinIds.length)return true;
  if(spinIds.length>5||new Set(spinIds).size!==spinIds.length||spinIds.some(id=>!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)))return false;
  try{
    const {data,error}=await sb.rpc("record_fan_reward_views",{p_spins:[...spinIds],p_token:token});
    return !error&&data===spinIds.length;
  }catch{return false;}
}
