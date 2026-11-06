import "server-only";
import { bingoEligible, BINGO_FULL_MASK, type BingoPresentation, type BingoState } from "@/lib/games/bingo/engine";
import type { WheelConfig } from "@/lib/games/core/types";
export interface MockBingoCard { id:string;fanId:string;wheelId:string;state:BingoState;createdAt:string;completedAt:string|null }
export interface MockBingoAward { id:string;cardId:string;fanId:string;wheelId:string;line:number;parentShareId:string;bonusShareId:string;at:string }
interface Store { cards:Map<string,MockBingoCard>;current:Map<string,string>;awards:Map<string,MockBingoAward> }
const globals=globalThis as unknown as {__ffBingo?:Store};
export const mockBingoStore=():Store=>globals.__ffBingo??={cards:new Map(),current:new Map(),awards:new Map()};
const key=(fanId:string,wheelId:string)=>JSON.stringify([fanId,wheelId]);
export function currentMockBingo(fanId:string,wheelId:string):MockBingoCard|null { const store=mockBingoStore();return store.cards.get(store.current.get(key(fanId,wheelId))??"")??null; }
export function mockBingoEditError(wheelId:string,next:WheelConfig|null):string|null {
  const cards=[...mockBingoStore().cards.values()].filter(card=>card.wheelId===wheelId&&card.state.markedMask!==BINGO_FULL_MASK);
  if(!cards.length)return null;
  if(!next)return "game_in_use";
  for(const card of cards)for(const cell of card.state.cells)if(!next.prizes.some(prize=>prize.id===cell.id&&bingoEligible(prize)))return "bingo_active_card";
  return null;
}
export function commitMockBingo(fanId:string,wheelId:string,presentation:BingoPresentation,parentShareId:string,bonuses:{line:number;shareId:string}[],at:string):MockBingoCard {
  const store=mockBingoStore(),previous=currentMockBingo(fanId,wheelId);
  if(JSON.stringify(previous?.state??null)!==JSON.stringify(presentation.before))throw new Error("Bingo context changed");
  const card:MockBingoCard=presentation.newCard?{id:crypto.randomUUID(),fanId,wheelId,state:structuredClone(presentation.after),createdAt:at,completedAt:null}:previous!;
  for(const bonus of bonuses)if(store.awards.has(`${card.id}:${bonus.line}`))throw new Error("Line already awarded");
  card.state=structuredClone(presentation.after);card.completedAt=card.state.markedMask===BINGO_FULL_MASK?at:null;
  store.cards.set(card.id,card);store.current.set(key(fanId,wheelId),card.id);
  for(const bonus of bonuses)store.awards.set(`${card.id}:${bonus.line}`,{id:crypto.randomUUID(),cardId:card.id,fanId,wheelId,line:bonus.line,parentShareId,bonusShareId:bonus.shareId,at});
  return card;
}
export function eraseMockBingo(fanId:string):void { const store=mockBingoStore();for(const[id,card]of store.cards)if(card.fanId===fanId){store.cards.delete(id);store.current.delete(key(fanId,card.wheelId));}for(const[id,award]of store.awards)if(award.fanId===fanId)store.awards.delete(id); }
export function clearMockBingo():void {const store=mockBingoStore();store.cards.clear();store.current.clear();store.awards.clear();}
