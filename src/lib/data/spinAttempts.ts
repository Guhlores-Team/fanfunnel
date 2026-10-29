import { recordRewardDisclosures } from "./rewardDisclosures";
import { gameProposal, addBonusFailure } from "./gameProposal";
import { readBingoCard } from "./bingo";
import { parseBingoState } from "@/lib/games/bingo/state";
import type { BingoState } from "@/lib/games/bingo/engine";
import { buildBingoPoolSnapshot, buildScratchPoolSnapshot, hashGamePoolSnapshot, type GamePoolSnapshot } from "@/lib/games/core/gameProof";
import { type GamePresentation, type GameTrace, type BonusFailurePlan } from "@/lib/games/core/play";
import { parseGamePresentation } from "@/lib/games/core/presentation";
import { getFanFocusDisplay } from "./focus";
import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { makeFairRngV3, normalizeClientSeed, randomSeedHex, sha256Hex } from "@/lib/games/wheel/fairness";
import { buildFocusPoolSnapshot, drawFromSnapshot, hashPoolSnapshot } from "@/lib/games/wheel/fairnessV3";
import { openReward } from "@/lib/rewards/crypto";
import type { DeliveredReward, PrizeDelivery } from "@/lib/rewards/config";
import type { Prize, SpinResult } from "@/lib/games/wheel/types";
import { showsStock, toPublicPrize } from "@/lib/games/wheel/publicView";
import { toWheelConfig, type DbWheelRow, type SpinError, isUuid } from "./shared";
import { toFanFocusView, type FocusRow } from "./focusView";
import { fireWebhooks } from "./webhooks";
import { notifyCreator } from "@/lib/push/notify";
import { runAfterResponse } from "@/lib/afterResponse";
import { readPlayAfterSpin } from "./playGuard";

export interface SpinIntent { requestId: string; clientSeed?: unknown; publishedSeedHash?: string }
export function validSpinIntent(value: unknown): value is SpinIntent {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  return typeof x.requestId === "string" && isUuid(x.requestId)
    && (x.clientSeed == null || (typeof x.clientSeed === "string" && x.clientSeed.length <= 256))
    && (x.publishedSeedHash == null || (typeof x.publishedSeedHash === "string" && /^[a-f0-9]{64}$/i.test(x.publishedSeedHash)));
}
/** Stable, token-independent binding. Token ownership is checked separately under the RPC lock. */
export async function spinIntentHash(intent: SpinIntent): Promise<string> {
  return sha256Hex(JSON.stringify(["spin-attempt-v1", "wheel", normalizeClientSeed(intent.clientSeed), intent.publishedSeedHash?.toLowerCase() ?? null]));
}
type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }> };
type Service = ReturnType<typeof createServiceClient>;
type Context = {
  contextHash: string; fanId: string; passId: string; creatorId: string; wheelId: string; campaignId: string | null;
  serverSeed: string; serverSeedHash: string; nonce: number; pityCounter: number;
  happyHourMultiplier: number | null; focus: FocusRow | null;
  reservation: { code_id?: string; prize_id?: string } | null;
  bingoCard?: { id:string;version:number;cells:unknown;marked_mask:number;awarded_lines_mask:number;status:string } | null;
  wheel: DbWheelRow; prizes: DbWheelRow["prizes"]; commitment: "fresh" | "stored";
};
type SpinRow = { id: string; creator_id: string; fan_id: string; wheel_id: string; prize_id: string; prize_label: string; prize_rarity: Prize["rarity"]; prize_image_url?: string | null; pool_hash?: string; created_at?: string; game_kind?: "wheel" | "scratch" | "bingo"; presentation?: unknown };
type Receipt = {
  status: "committed"; id: string; shareId: string; replayed?: boolean; balance: number; nextServerSeedHash: string;
  stockAfter: number | null; focus: FocusRow | null; spin: SpinRow;
  pityAwarded?: boolean; chaseAwarded?: boolean; chaseCompleted?: boolean; focusConsumed?: boolean; chaseConsumed?: boolean;
  prize?: Prize; prizeIndex?: number; showStock?: boolean;
  gameKind?: "wheel" | "scratch" | "bingo"; presentation?: unknown; bonusWins?: {line:number;shareId:string;prize:Prize;spin:SpinRow;stockAfter?:number|null;reward?:Receipt["reward"]}[];
  reward?: { kind: DeliveredReward["kind"]; cipher: string; iv: string; keyVersion: number } | null;
};
export type SpinAttemptStatus = { status: "committed"; result: SpinResult } | { status: "absent" | "pending" | "conflict" | "unavailable" } | { status: "declined"; error: SpinError["error"] };
const ERROR_CODES: ReadonlySet<string> = new Set(["not_found", "no_spins", "no_prizes", "rate_limited", "blocked", "on_break", "needs_ack", "db_error", "spin_pending"]);
function spinError(error: unknown): SpinError { return { error: typeof error === "string" && ERROR_CODES.has(error) ? error as SpinError["error"] : "db_error" }; }
async function call(sb: Service, name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await (sb as unknown as RpcClient).rpc(name, args);
    if (error || !data || typeof data !== "object") return null;
    return data as Record<string, unknown>;
  } catch { return null; }
}
function resultFromReceipt(receipt: Receipt, requestId: string): SpinResult {
  const p = receipt.prize ?? { id: receipt.spin.prize_id, label: receipt.spin.prize_label, rarity: receipt.spin.prize_rarity, weight: 0, imageUrl: receipt.spin.prize_image_url ?? null };
  const reward = receipt.reward ? { kind: receipt.reward.kind, value: openReward(receipt.reward, receipt.spin.creator_id) } : null;
  const kind = receipt.gameKind ?? receipt.spin.game_kind ?? "wheel";
  if (!["wheel","scratch","bingo"].includes(kind)) throw new Error("Unknown game receipt");
  const presentation = kind !== "wheel" ? parseGamePresentation(receipt.presentation ?? receipt.spin.presentation, { kind, prizeId: p.id, label: p.label }) : null;
  if (kind === "scratch" && (!presentation || (receipt.bonusWins !== undefined && (!Array.isArray(receipt.bonusWins) || receipt.bonusWins.length !== 0)))) throw new Error("Invalid committed scratch presentation");
  const bonuses=receipt.bonusWins??[];
  if(kind === "bingo" && (!presentation || presentation.kind!=="bingo" || !Array.isArray(receipt.bonusWins) || bonuses.length!==presentation.newLines.length ||
    bonuses.some((bonus,index)=>bonus.line!==presentation.newLines[index]||!bonus.shareId||!bonus.spin||!bonus.prize)||new Set(bonuses.map(bonus=>bonus.shareId)).size!==bonuses.length))throw new Error("Invalid Bingo bonus receipt");
  return {
    ...(kind !== "wheel" ? { gameKind: kind, presentation: presentation!, bonusWins: bonuses.map(bonus=>({line:bonus.line,shareId:bonus.shareId,prize:toPublicPrize(bonus.prize,{showStock:receipt.showStock??true}),
      ...(bonus.spin.created_at?{awardedAt:bonus.spin.created_at}:{}),...(bonus.reward?{instant:true,reward:{kind:bonus.reward.kind,value:openReward(bonus.reward,bonus.spin.creator_id)}}:{})})) } : {}),
    attemptId: requestId, replayed: receipt.replayed === true,
    ...(receipt.spin.created_at ? { awardedAt: receipt.spin.created_at } : {}),
    prize: toPublicPrize(p, { showStock: receipt.showStock ?? true }), prizeIndex: receipt.prizeIndex ?? 0,
    spinsRemaining: receipt.balance, shareId: receipt.shareId, nextSpinHash: receipt.nextServerSeedHash,
    fairVersion: 3, ...(receipt.spin.pool_hash ? { poolHash: receipt.spin.pool_hash } : {}),
    pityAwarded: receipt.pityAwarded === true, chaseAwarded: receipt.chaseAwarded === true,
    chaseCompleted: receipt.chaseCompleted === true, focusConsumed: receipt.focusConsumed === true, chaseConsumed: receipt.chaseConsumed === true,
    focus: toFanFocusView(receipt.focus), ...(reward ? { reward } : {}),
  };
}
async function refreshReceipt(token:string,receipt:Receipt,requestId:string,sb:Service):Promise<SpinResult> {
  const result=resultFromReceipt(receipt,requestId);
  const response={...result,...(await readPlayAfterSpin(sb,receipt.spin.fan_id)),...(await getFanFocusDisplay(token,sb)),...(result.gameKind==="bingo"?{bingoCard:await readBingoCard(token,sb)}:{})};
  const exposed=[...(result.reward?[receipt.spin.id]:[]),...(result.bonusWins??[]).flatMap((bonus,index)=>bonus.reward?[receipt.bonusWins![index].spin.id]:[])];
  if(!await recordRewardDisclosures(sb,token,exposed))throw new Error("reward_disclosure_pending");
  return response;
}
/** A read cannot authorize a fresh attempt. Absent and pending retain the SAME request identity. */
export async function readSpinAttempt(token: string, intent: SpinIntent, sb = createServiceClient()): Promise<SpinAttemptStatus> {
  const reply = await call(sb, "get_spin_attempt_status", { p_attempt: intent.requestId, p_token: token, p_request_hash: await spinIntentHash(intent) });
  if (!reply) return { status: "unavailable" };
  if (reply.status === "committed") {
    try {
      const receipt = { ...reply, replayed: true } as Receipt;
      return { status: "committed", result: await refreshReceipt(token,receipt,intent.requestId,sb) };
    }
    catch { return { status: "pending" }; }
  }
  if (reply.status === "declined") return { status: "declined", ...spinError(reply.error) };
  return { status: reply.status === "absent" || reply.status === "pending" || reply.status === "conflict" ? reply.status : "unavailable" };
}
type ExpectedReward = { delivery: PrizeDelivery; codeId?: string; cipher?: string; iv?: string; keyVersion?: number };
type RewardCandidate = { status: "ready"; candidate: ExpectedReward } | { status: "sold_out" } | { status: "unavailable" } | { status: "error" };
async function expectedReward(sb: Service, ctx: Context, prize: Prize, usedCodes:ReadonlySet<string>=new Set()): Promise<RewardCandidate> {
  const delivery = prize.delivery ?? "manual";
  if (delivery === "manual") return { status: "ready", candidate: { delivery } };
  let row: { id?: string; kind?: string; cipher: string; iv: string; key_version: number } | null;
  if (delivery === "codes") {
    let q = sb.from("prize_reward_codes").select("id,cipher,iv,key_version").eq("creator_id", ctx.creatorId).eq("prize_id", prize.id).is("spin_id", null);
    const reserved = ctx.reservation?.prize_id === prize.id ? ctx.reservation.code_id : undefined;
    // A held chase code must be selected by its concrete identity; SQL also validates ownership.
    if (reserved) q = q.eq("id", reserved);
    else q = q.is("reserved_focus_id", null);
    if(usedCodes.size)q=q.not("id","in",`(${[...usedCodes].filter(isUuid).join(",")})`);
    const { data, error } = await q.order("created_at").order("id").limit(1).maybeSingle();
    if (error) return { status: "error" };
    row = data;
  } else {
    const { data, error } = await sb.from("prize_rewards").select("kind,cipher,iv,key_version").eq("creator_id", ctx.creatorId).eq("prize_id", prize.id).maybeSingle();
    if (error) return { status: "error" };
    if (data?.kind !== delivery) return { status: "unavailable" };
    row = data;
  }
  if (!row) return { status: delivery === "codes" ? "sold_out" : "unavailable" };
  const candidate = { delivery, ...(row.id ? { codeId: row.id } : {}), cipher: row.cipher, iv: row.iv, keyVersion: row.key_version };
  try { openReward(candidate, ctx.creatorId); return { status: "ready", candidate }; } catch { return { status: "unavailable" }; }
}
async function declineAttempt(sb: Service, token: string, intent: SpinIntent, error: "no_prizes" | "reward_unavailable" = "no_prizes"): Promise<SpinResult | SpinError> {
  const reply = await call(sb, "cancel_spin_attempt", { p_attempt: intent.requestId, p_token: token, p_request_hash: await spinIntentHash(intent), p_error: error });
  if (reply?.status === "committed") {
    try { const receipt = { ...reply, replayed: true } as Receipt;
      return await refreshReceipt(token,receipt,intent.requestId,sb);
    } catch { return { error: "spin_pending" }; }
  }
  return reply?.status === "declined" ? spinError(reply.error) : { error: "spin_pending" };
}

/** No credit, stock, seed, card, award, pity or focus write occurs outside one commit. */
export async function commitSpinAttempt(token:string,intent:SpinIntent,sb=createServiceClient()):Promise<SpinResult|SpinError> {
  const binding={p_attempt:intent.requestId,p_token:token,p_request_hash:await spinIntentHash(intent)};
  for(let contextTry=0;contextTry<8;contextTry++){
    const prepared=await call(sb,"prepare_spin_attempt",binding);
    if(!prepared)return {error:"spin_pending"};
    if(prepared.status==="committed"){try{return await refreshReceipt(token,{...prepared,replayed:true} as Receipt,intent.requestId,sb);}catch{return {error:"spin_pending"};}}
    if(prepared.status==="declined")return spinError(prepared.error);
    if(prepared.status!=="ready")return {error:"spin_pending"};
    const ctx=prepared.context as Context,config=toWheelConfig({...ctx.wheel,prizes:ctx.prizes}),kind=config.gameKind??"wheel",focus=toFanFocusView(ctx.focus);
    if(config.gameReady===false)return declineAttempt(sb,token,intent);
    // Context includes the personally held unit for primary odds. Bingo bonuses
    // use ordinary FREE inventory only; composeModifiers injects its reserved primary.
    if(kind==="bingo"&&ctx.reservation?.prize_id){const held=config.prizes.find(prize=>prize.id===ctx.reservation?.prize_id);if(held&&typeof held.stock==="number")held.stock=Math.max(0,held.stock-1);}
    const options={happyHourMultiplier:ctx.happyHourMultiplier,pityCounter:ctx.pityCounter,
      ...(focus?.kind==="focus"?{focus:{prizeId:focus.prizeId,multiplier:focus.multiplier,spinsLeft:focus.spinsLeft,totalSpins:focus.totalSpins}}:{}),
      ...(focus?.kind==="chase"?{chase:{prizeId:focus.prizeId,counter:focus.chaseCounter,within:focus.chaseWithin,reserved:!!ctx.reservation}}:{})};
    let card:BingoState|null=null;
    if(ctx.bingoCard){card=parseBingoState({cells:ctx.bingoCard.cells,markedMask:ctx.bingoCard.marked_mask,awardedLinesMask:ctx.bingoCard.awarded_lines_mask,version:ctx.bingoCard.version});if(!card)return {error:"spin_pending"};}
    let snapshot:ReturnType<typeof buildFocusPoolSnapshot>|GamePoolSnapshot;
    try{snapshot=kind==="scratch"?buildScratchPoolSnapshot(config,options):kind==="bingo"?buildBingoPoolSnapshot(config,options,config.gameConfig as {size:3;linePrizeId:string},card):buildFocusPoolSnapshot(config,options);}catch{return declineAttempt(sb,token,intent);}
    const game=snapshot.game==="wheel"?null:snapshot as GamePoolSnapshot;
    const poolHash=game?await hashGamePoolSnapshot(game):await hashPoolSnapshot(snapshot as ReturnType<typeof buildFocusPoolSnapshot>);
    const legacyRng=game?null:await makeFairRngV3(ctx.serverSeed,normalizeClientSeed(intent.clientSeed),ctx.nonce,poolHash);
    const excluded:string[]=[];let failures:BonusFailurePlan[]=[],reprepare=false,changed=0;
    const bonusIds=new Map<number,string>();
    let legacyDraw:ReturnType<typeof drawFromSnapshot>|null=null;
    for(let proposalTry=0;proposalTry<64;proposalTry++){
      let draw:ReturnType<typeof drawFromSnapshot>,presentation:GamePresentation|undefined,trace:GameTrace|{excluded:string[];won:string},bonuses:{line:number;prize:import("@/lib/games/bingo/engine").BonusPrize}[]=[];
      try{if(game){const proposed=await gameProposal(game,ctx.serverSeed,normalizeClientSeed(intent.clientSeed),ctx.nonce,poolHash,excluded,failures);draw=proposed.primary;presentation=proposed.presentation;trace=proposed.trace;bonuses=proposed.bonuses;}
        else{draw=legacyDraw??drawFromSnapshot(snapshot as ReturnType<typeof buildFocusPoolSnapshot>,new Set(excluded),legacyRng!);legacyDraw=draw;trace={excluded:[...excluded],won:draw.prize.id};}}
      catch{return declineAttempt(sb,token,intent);}
      const index=config.prizes.findIndex(prize=>prize.id===draw.prize.id),prize=config.prizes[index];if(!prize)return {error:"db_error"};
      const usedCodes=new Set<string>(),free=new Map(config.prizes.map(prize=>[prize.id,prize.stock??null]));
      const reserve=(target:Prize,primary:boolean)=>{if(primary&&ctx.reservation?.prize_id===target.id)return true;const left=free.get(target.id);if(typeof left!=="number")return true;if(left<=0)return false;free.set(target.id,left-1);return true;};
      const primaryCandidate=await expectedReward(sb,ctx,prize,usedCodes);
      if(primaryCandidate.status==="error")return {error:"spin_pending"};
      if(primaryCandidate.status==="unavailable")return declineAttempt(sb,token,intent,"reward_unavailable");
      if(primaryCandidate.status==="sold_out"||!reserve(prize,true)){if(ctx.reservation?.prize_id===prize.id)return declineAttempt(sb,token,intent,"reward_unavailable");if(excluded.includes(prize.id))return {error:"spin_pending"};excluded.push(prize.id);legacyDraw=null;failures=[];continue;}
      if(primaryCandidate.candidate.codeId)usedCodes.add(primaryCandidate.candidate.codeId);
      const bonusRows:Record<string,unknown>[]=[];let retryBonus=false;
      for(const bonus of bonuses){
        const target=config.prizes.find(prize=>prize.id===bonus.prize.id);if(!target)return {error:"db_error"};
        const candidate=await expectedReward(sb,{...ctx,reservation:null},target,usedCodes);
        if(candidate.status==="error")return {error:"spin_pending"};
        if(candidate.status==="unavailable")return declineAttempt(sb,token,intent,"reward_unavailable");
        if(candidate.status==="sold_out"||!reserve(target,false)){try{failures=addBonusFailure(failures,bonus.line,target.id);}catch{return {error:"spin_pending"};}retryBonus=true;break;}
        if(candidate.candidate.codeId)usedCodes.add(candidate.candidate.codeId);
        if(!bonusIds.has(bonus.line))bonusIds.set(bonus.line,crypto.randomUUID());
        bonusRows.push({id:bonusIds.get(bonus.line),line:bonus.line,prize_id:target.id,prize_label:target.label,prize_rarity:target.rarity,prize_image_url:target.imageUrl??null,
          response_prize:toPublicPrize(target,{showStock:showsStock(config)}),expected_reward:candidate.candidate});
      }
      if(retryBonus)continue;
      const nextSeed=randomSeedHex(),upgraded=draw as typeof draw&{focusConsumed?:boolean;chaseConsumed?:boolean;chaseCompleted?:boolean;chaseAwarded?:boolean;nextFocusSpinsLeft?:number|null;nextChaseCounter?:number|null};
      const spin={id:intent.requestId,fan_pass_id:ctx.passId,creator_id:ctx.creatorId,wheel_id:ctx.wheelId,fan_id:ctx.fanId,
        prize_id:prize.id,prize_label:prize.label,prize_rarity:prize.rarity,prize_image_url:prize.imageUrl??null,campaign_id:ctx.campaignId,
        server_seed:ctx.serverSeed,server_seed_hash:ctx.serverSeedHash,nonce:ctx.nonce,client_seed:normalizeClientSeed(intent.clientSeed)||null,
        seed_commitment:ctx.commitment==="fresh"?"fresh":intent.publishedSeedHash?.toLowerCase()===ctx.serverSeedHash.toLowerCase()?"published":"stored",
        fair_version:3,pool_snapshot:snapshot,pool_hash:poolHash,fair_trace:trace,
        next_pity_counter:draw.nextPityCounter,pity_awarded:draw.pityAwarded,focus_consumed:upgraded.focusConsumed??false,chase_consumed:upgraded.chaseConsumed??false,chase_completed:upgraded.chaseCompleted??false,chase_awarded:upgraded.chaseAwarded??false,
        next_focus_spins_left:upgraded.nextFocusSpinsLeft??null,next_chase_counter:upgraded.nextChaseCounter??null,
        response_prize:toPublicPrize(prize,{showStock:showsStock(config)}),response_prize_index:index,response_show_stock:showsStock(config),
        ...(game?{game_kind:kind,presentation,bonuses:bonusRows}:{})};
      const args={...binding,p_context:{contextHash:ctx.contextHash,publishedSeedHash:intent.publishedSeedHash?.toLowerCase()??null,...(kind==="bingo"?{cardId:ctx.bingoCard?.id??null,cardVersion:ctx.bingoCard?.version??null}:{})},p_spin:spin,p_expected_reward:primaryCandidate.candidate,p_next_seed:{seed:nextSeed,hash:await sha256Hex(nextSeed)}};
      let reply:Record<string,unknown>|null=null;for(let transport=0;transport<3&&!reply;transport++)reply=await call(sb,"commit_spin_attempt",args);
      if(!reply)return {error:"spin_pending"};
      if(reply.status==="retry_context"){reprepare=true;break;}
      if(reply.status==="changed"){if(++changed>=8)return {error:"spin_pending"};continue;}
      if(reply.status==="sold_out"){
        const line=reply.line;
        if(typeof line==="number"){
          const failed=bonuses.find(bonus=>bonus.line===line);if(!failed||reply.prizeId!==failed.prize.id)return {error:"spin_pending"};
          try{failures=addBonusFailure(failures,line,failed.prize.id);}catch{return {error:"spin_pending"};}
        }else{if(excluded.includes(prize.id))return {error:"spin_pending"};excluded.push(prize.id);legacyDraw=null;failures=[];}
        continue;
      }
      if(reply.status==="declined")return spinError(reply.error);
      if(reply.status!=="committed")return {error:"spin_pending"};
      const receipt=reply as Receipt;
      if(receipt.replayed!==true){
        const events=[{prize,spin:receipt.spin,reward:receipt.reward,stockAfter:receipt.stockAfter},...(receipt.bonusWins??[]).map(bonus=>({prize:bonus.prize,spin:bonus.spin,reward:bonus.reward,stockAfter:bonus.stockAfter??null}))];
        for(const event of events){runAfterResponse(()=>fireWebhooks(ctx.creatorId,{event:event.reward?"prize_delivered":"prize_pending",prize:event.prize.label,rarity:event.prize.rarity,at:event.spin.created_at??new Date().toISOString()}));
          runAfterResponse(()=>notifyCreator(ctx.creatorId,{type:"spin",spinId:event.spin.id,fanId:ctx.fanId,prizeId:event.prize.id,stockAfter:event.stockAfter}));}
      }
      try{return await refreshReceipt(token,receipt,intent.requestId,sb);}catch{return {error:"spin_pending"};}
    }
    if(!reprepare)return {error:"spin_pending"};
  }
  return {error:"spin_pending"};
}
